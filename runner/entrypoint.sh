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

exec node "${package_root}/runner/runner.js" "$@"
