#!/usr/bin/env bash
# Installs the fix runner on a plain machine, under systemd, from a clone of
# this package.
#
# It creates the account and the directories, copies the package to
# /opt/sre-agent-opencode, writes the unit, and leaves an environment file the
# operator fills in. It never writes a credential: the poll key, the provider
# key and the repository token are the customer's, and a script that wrote one
# would either invent it or take it on a command line, where it would land in
# the shell history of a machine that is about to hold live credentials.
#
# Everything it needs is checked before the first write, each gap with the
# command that closes it, because a half-installed runner fails on the
# customer's first fix request rather than here.
set -euo pipefail

SERVICE=sre-agent-fix-runner
PACKAGE_DIR=/opt/sre-agent-opencode
STATE_DIR=/var/lib/sre-agent-fix-runner
WORKSPACE_DIR=/var/lib/sre-agent-fix-runner/workspace
ENV_DIR=/etc/sre-agent-fix-runner
ENV_FILE=/etc/sre-agent-fix-runner/env
UNIT_FILE=/etc/systemd/system/sre-agent-fix-runner.service

here="$(cd "$(dirname "$0")" && pwd)"
source_root="$(cd "$here/.." && pwd)"
prefix=""

usage() {
  cat <<'USAGE'
usage: install-runner.sh [--prefix <dir>]

  --prefix <dir>   write every file under <dir> instead of /. For packaging
                   and for this package's own tests. The account is still
                   created, because the unit names it.

Run it as root, from a clone of segfaultpw/sre-agent-opencode.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option ${1}" >&2; usage >&2; exit 2 ;;
  esac
done
prefix="${prefix%/}"

at() { printf '%s%s' "$prefix" "$1"; }

# id, rather than $EUID, so the check is one PATH lookup like every other
# command here and the tests can answer it.
if [ "$(id -u)" -ne 0 ]; then
  echo "install-runner.sh writes to ${UNIT_FILE} and creates the ${SERVICE} account, so it has to run as root" >&2
  echo "           fix: sudo bash $0" >&2
  exit 1
fi

missing=()
lack() { missing+=("$1"$'\n'"           fix: $2"); }

if ! command -v systemctl >/dev/null 2>&1; then
  lack "this machine has no systemctl, and this installer only knows how to install a systemd unit" \
    "run the container image instead: docker run ghcr.io/segfaultpw/sre-agent-opencode-runner:v1"
fi

# The files the runner reads at run time. A clone that is missing one of them
# would install a runner that starts and fails its first job.
for relative in VERSION config/opencode.json agents/sre-fix.md scripts/protected_paths.sh \
  runner/runner.js runner/entrypoint.sh runner/sre-agent-fix-runner.service; do
  if [ ! -f "${source_root}/${relative}" ]; then
    lack "${source_root} has no ${relative}, so this is not a complete clone of the package" \
      "git clone https://github.com/segfaultpw/sre-agent-opencode && cd sre-agent-opencode"
  fi
done

# The same four the entrypoint checks for at start, checked here as well so
# they are reported while the operator is still installing.
for tool in node git gh opencode; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      node) lack "node is not on PATH, and the runner is a Node program" "install Node 20 or newer from your distribution or from https://nodejs.org" ;;
      git) lack "git is not on PATH, and the runner clones the repository it is asked to fix" "install git from your distribution" ;;
      gh) lack "gh is not on PATH, and the runner opens the pull request with it" "install the GitHub CLI from https://github.com/cli/cli/releases" ;;
      opencode) lack "opencode is not on PATH, and it is what answers the fix request" "curl -fsSL https://opencode.ai/install | bash" ;;
    esac
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "refusing to install: nothing has been written" >&2
  for line in "${missing[@]}"; do printf '  %-8s %s\n' missing "$line" >&2; done
  exit 1
fi

if ! getent group "$SERVICE" >/dev/null 2>&1; then
  groupadd --system "$SERVICE"
  echo "created the ${SERVICE} group"
fi
if ! getent passwd "$SERVICE" >/dev/null 2>&1; then
  # The home directory is the state directory, not somewhere under /home: the
  # unit sets ProtectHome, so a home under /home would be invisible to the
  # process, and opencode keeps its own state under HOME.
  useradd --system --gid "$SERVICE" --home-dir "$STATE_DIR" --no-create-home \
    --shell /usr/sbin/nologin --comment "SRE Agent fix runner" "$SERVICE"
  echo "created the ${SERVICE} account"
fi

package_path="$(at "$PACKAGE_DIR")"
state_path="$(at "$STATE_DIR")"
workspace_path="$(at "$WORKSPACE_DIR")"
env_path="$(at "$ENV_FILE")"
unit_path="$(at "$UNIT_FILE")"

install -d -m 0755 "$package_path"
install -d -m 0750 "$state_path"
install -d -m 0750 "$workspace_path"
install -d -m 0750 "$(at "$ENV_DIR")"
chown "${SERVICE}:${SERVICE}" "$state_path" "$workspace_path"

# The package is root-owned and not writable by the account the agent runs
# under, so a run cannot edit the fences the next run will load. Each directory
# is removed before it is copied, because copying a directory onto itself
# nests it rather than replacing it.
for relative in VERSION config agents scripts runner; do
  rm -rf "${package_path:?}/${relative:?}"
  cp -R "${source_root}/${relative}" "${package_path}/${relative}"
done
chown -R root:root "$package_path"
chmod -R go-w "$package_path"
chmod 0755 "${package_path}/runner/entrypoint.sh"

# Present on any systemd machine; created here so that a prefixed install has
# somewhere to put the unit as well.
install -d -m 0755 "$(at "$(dirname "$UNIT_FILE")")"
install -m 0644 "${source_root}/runner/sre-agent-fix-runner.service" "$unit_path"
chown root:root "$unit_path"
echo "installed ${UNIT_FILE}"

if [ -f "$env_path" ]; then
  echo "kept the existing ${ENV_FILE}"
else
  # The mode is set before a byte is written, so the file is never briefly
  # readable by everyone; and what is written is a template with no values in
  # it, since the credentials are the operator's to paste.
  install -m 0600 /dev/null "$env_path"
  cat > "$env_path" <<'TEMPLATE'
# SRE Agent fix runner. Fill in the three required values below, then start it:
#
#   systemctl enable --now sre-agent-fix-runner
#
# systemd reads this file as root and passes the values to the runner, so the
# account the runner runs as never reads it. Keep it 0600 and root-owned.

# Where SRE Agent runs, for example https://app.example.com
SRE_SERVER_URL=

# An organization API key whose only scope is fix_runner:poll. It reaches the
# queue and nothing else.
SRE_API_KEY=

# provider/model, for example openrouter/deepseek/deepseek-v4-pro
SRE_MODEL=

# The provider key for the model above, under the variable name that provider
# uses. scripts/provider_env.sh maps a model to its variable; for
# openrouter/... it is the one below.
# OPENROUTER_API_KEY=

# A token that may push a branch and open a pull request in the repositories
# this runner is asked to fix. Without one it can still answer a request that
# names no repository, which is a diagnosis rather than a change.
SRE_GITHUB_TOKEN=

# Optional. How long one agent run may take, 1800 seconds by default.
# SRE_RUN_TIMEOUT_SECONDS=1800

# Optional. debug, info, warn or error.
# SRE_LOG_LEVEL=info
TEMPLATE
  chown root:root "$env_path"
  echo "wrote ${ENV_FILE} as a template, 0600 and owned by root"
fi

systemctl daemon-reload

cat <<NEXT

Installed. Nothing is running yet, and no credential was written by this script.

What is left, in order:

  1. In SRE Agent, under Integrations, Fix runner, register this runner and
     create an API key whose only scope is fix_runner:poll.
  2. Fill in SRE_SERVER_URL, SRE_API_KEY and SRE_MODEL in ${ENV_FILE},
     along with your provider key and, if this runner is to open pull
     requests, SRE_GITHUB_TOKEN.
  3. systemctl enable --now ${SERVICE}
  4. journalctl -u ${SERVICE} -f

The runner refuses to start while any of those three values is empty, and says
which one. What it can reach on this machine is what the agent can reach: give
it a read-only role, and a machine of its own if your CI holds production
credentials.
NEXT
