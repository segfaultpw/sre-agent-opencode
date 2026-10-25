#!/usr/bin/env bash
# Starts the fix runner, or refuses to start at all.
#
# A runner that starts without its configuration looks healthy and then fails
# every job, so the first failure a customer sees is on a real fix request,
# with a card already waiting on it. Everything the runner cannot work without
# is checked here instead, and named.
#
# The systemd unit runs this too rather than node directly, so a plain machine
# and a container refuse for the same reasons and with the same words.
set -euo pipefail

# Located with bash's own expansion rather than dirname, so the checks below
# still run on a PATH too broken to resolve an external command, which is one
# of the things they are here to report.
self="${BASH_SOURCE[0]}"
self_dir="${self%/*}"
if [ "$self_dir" = "$self" ]; then self_dir="."; fi
package_root="$(cd "${self_dir}/.." && pwd)"

missing_vars=()
for name in SRE_SERVER_URL SRE_API_KEY SRE_MODEL; do
  if [ -z "${!name:-}" ]; then missing_vars+=("$name"); fi
done
if [ "${#missing_vars[@]}" -gt 0 ]; then
  for name in "${missing_vars[@]}"; do
    echo "sre-agent-fix-runner: ${name} is not set" >&2
  done
  echo "sre-agent-fix-runner: SRE_SERVER_URL, SRE_API_KEY and SRE_MODEL are required; the runner will not start without them" >&2
  exit 1
fi

# The runner shells out to all four, and the two publishing tools are only
# reached at the end of a job: a missing gh would otherwise be discovered
# after a checkout, a model call and a push.
missing_tools=()
for tool in node git gh opencode; do
  if ! command -v "$tool" >/dev/null 2>&1; then missing_tools+=("$tool"); fi
done
if [ "${#missing_tools[@]}" -gt 0 ]; then
  for tool in "${missing_tools[@]}"; do
    echo "sre-agent-fix-runner: ${tool} is not on PATH" >&2
  done
  echo "sre-agent-fix-runner: the runner needs node, git, gh and opencode on PATH; the container image carries them, and a plain machine needs them installed" >&2
  exit 1
fi

# Kept in step with runner.js's own default, which is what a run with no
# SRE_WORKSPACE would use.
workspace="${SRE_WORKSPACE:-/workspace}"
mkdir -p "$workspace" 2>/dev/null || true
if [ ! -d "$workspace" ] || [ ! -w "$workspace" ]; then
  echo "sre-agent-fix-runner: the workspace ${workspace} does not exist or is not writable by uid $(id -u); mount it writable, or point SRE_WORKSPACE somewhere this account owns" >&2
  exit 1
fi

# Who runs what. The runner starts every agent run as a second account, so that
# what the agent can reach is not what the runner can reach (its environment,
# the memory directory, every other clone). As root, which is how the container
# starts, the runner switches both ways itself; as anyone else it starts the
# agent through setpriv and needs the capabilities the systemd unit grants. The
# ids are resolved here, by name, so the runner is given numbers and never has
# to guess what an account is called.
resolve_account() {
  local role="$1" user="$2" prefix="$3" uid gid home
  if ! uid="$(id -u "$user" 2>/dev/null)" || ! gid="$(id -g "$user" 2>/dev/null)"; then
    echo "sre-agent-fix-runner: the ${role} account ${user} does not exist on this machine; create it, or name the one to use in ${prefix}_USER" >&2
    exit 1
  fi
  home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6)"
  if [ -z "$home" ]; then home="/"; fi
  export "${prefix}_UID=${uid}" "${prefix}_GID=${gid}" "${prefix}_HOME=${home}"
}

if [ "$(id -u)" = "0" ]; then
  runner_user="${SRE_RUNNER_USER:-runner}"
  agent_user="${SRE_AGENT_USER:-agent}"
  if [ "$runner_user" = "$agent_user" ]; then
    echo "sre-agent-fix-runner: the runner and the agent must be different accounts, and both are ${runner_user}" >&2
    exit 1
  fi
  resolve_account runner "$runner_user" SRE_RUNNER
  resolve_account agent "$agent_user" SRE_AGENT
  if [ "$SRE_RUNNER_UID" = "0" ] || [ "$SRE_AGENT_UID" = "0" ]; then
    echo "sre-agent-fix-runner: neither ${runner_user} nor ${agent_user} may be root" >&2
    exit 1
  fi
elif [ -n "${SRE_AGENT_USER:-}" ]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "sre-agent-fix-runner: setpriv is not on PATH, and it is how a runner that is not root starts the agent as ${SRE_AGENT_USER}; install util-linux" >&2
    exit 1
  fi
  resolve_account agent "$SRE_AGENT_USER" SRE_AGENT
fi

# An optional setup script of the operator's, for what the image does not carry
# (system packages, a certificate, a proxy setting). It is a file in the
# container, mounted or baked into a derived image, and the runner never fetches
# one. It runs here, once per container start, as root, after the accounts exist
# and before the runner starts, so before the first poll and before anything is
# handed to the agent. Its output is logged; if it fails the runner does not
# start. It gets an allowlisted environment, never the container's: the poll
# key, both GitHub tokens and every model provider key live there, nothing a
# package install does needs them, and its log is somebody's aggregator. What
# it keeps is what an install needs (PATH, locale, time zone, proxies) and the
# operator's own SRE_SETUP_* variables.
if [ -n "${SRE_RUNNER_SETUP:-}" ]; then
  setup="$SRE_RUNNER_SETUP"
  case "$setup" in
    *://*)
      echo "sre-agent-fix-runner: SRE_RUNNER_SETUP is a URL (${setup%%://*}://...); it names a file in the container, and the runner never fetches a script" >&2
      exit 1
      ;;
  esac
  if [ "$(id -u)" != "0" ]; then
    echo "sre-agent-fix-runner: SRE_RUNNER_SETUP is run as root by the container entrypoint, and this start is not root; on a host, do what the script does yourself" >&2
    exit 1
  fi
  if [ ! -f "$setup" ]; then
    echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, which is not a file in this container" >&2
    exit 1
  fi
  if [ ! -x "$setup" ]; then
    echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, which is not executable" >&2
    exit 1
  fi
  echo "sre-agent-fix-runner: running the setup script ${setup}"
  set +e
  setup_env=(PATH="$PATH" HOME=/root)
  for name in LANG LC_ALL TZ TERM HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    if [ -n "${!name+x}" ]; then setup_env+=("${name}=${!name}"); fi
  done
  while IFS= read -r name; do
    setup_env+=("${name}=${!name}")
  done < <(compgen -e | grep -E '^SRE_SETUP_[A-Za-z0-9_]+$' || true)
  env -i "${setup_env[@]}" "$setup" 2>&1 | while IFS= read -r line; do
    printf 'sre-agent-fix-runner: setup: %s\n' "$line"
  done
  setup_status="${PIPESTATUS[0]}"
  set -e
  if [ "$setup_status" -ne 0 ]; then
    echo "sre-agent-fix-runner: the setup script ${setup} exited ${setup_status}; the runner did not start" >&2
    exit 1
  fi
  echo "sre-agent-fix-runner: the setup script finished"
fi

exec node "${package_root}/runner/runner.js" "$@"
