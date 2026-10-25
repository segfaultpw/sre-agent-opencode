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

# The memory mirror runs the AWS CLI, and only when a bucket is configured, so
# a plain machine that mirrors nothing needs no AWS CLI. Without it every job's
# mirror would fail after the job, which is a worse place to find out.
if [ -n "${SRE_MEMORY_BUCKET:-}" ] && ! command -v aws >/dev/null 2>&1; then
  echo "sre-agent-fix-runner: aws is not on PATH, and SRE_MEMORY_BUCKET names the bucket the runner mirrors its memory to with the AWS CLI; the container image carries it, and a plain machine needs it installed (or SRE_MEMORY_BUCKET unset)" >&2
  exit 1
fi

# Kept in step with runner.js's own default, which is what a run with no
# SRE_WORKSPACE would use.
workspace="${SRE_WORKSPACE:-/workspace}"
# With a setup script, the workspace is resolved once here: the script is refused
# when it is on the workspace, and a workspace of / puts every path there.
workspace_real=""
if [ -n "${SRE_RUNNER_SETUP:-}" ]; then
  workspace_real="$(realpath -m -- "$workspace")"
  if [ "$workspace_real" = "/" ]; then
    echo "sre-agent-fix-runner: SRE_RUNNER_SETUP is set and the workspace is / (SRE_WORKSPACE=${workspace}), which would make every file in the container part of the volume the agent writes; point SRE_WORKSPACE at a directory of its own" >&2
    exit 1
  fi
fi
mkdir -p "$workspace" 2>/dev/null || true
if [ ! -d "$workspace" ] || [ ! -w "$workspace" ]; then
  echo "sre-agent-fix-runner: the workspace ${workspace} does not exist or is not writable by uid $(id -u); mount it writable, or point SRE_WORKSPACE somewhere this account owns" >&2
  exit 1
fi

# The workspace split, the same decision runner.js makes from the same
# variables: with SRE_WORKSPACE_PER_INSTANCE=1 the runner works under
# <workspace>/instances/<instance>, and the instance id is SRE_RUNNER_INSTANCE
# when it is a name the runner can use, else the hostname. The directory is
# made and checked here for the same reason the workspace is: a start that
# cannot work its own volume refuses now, with the path named, instead of
# failing its first job.
if [ "${SRE_WORKSPACE_PER_INSTANCE:-}" = "1" ]; then
  instance="${SRE_RUNNER_INSTANCE:-}"
  if [ -n "$instance" ] && { ! printf '%s' "$instance" | grep -Eqx '[A-Za-z0-9._-]{1,100}' || ! printf '%s' "$instance" | grep -q '[^.]'; }; then
    echo "sre-agent-fix-runner: SRE_RUNNER_INSTANCE is not a name the runner can use (letters, digits, dots, underscores and hyphens, at most 100 characters), so the instance id falls back to the hostname" >&2
    instance=""
  fi
  if [ -z "$instance" ]; then
    # Read from the kernel rather than the hostname command, so this still runs
    # on a PATH too broken to resolve one, like the checks above.
    if [ -r /proc/sys/kernel/hostname ]; then
      read -r instance < /proc/sys/kernel/hostname
    else
      instance="$(hostname 2>/dev/null || true)"
    fi
    if ! printf '%s' "$instance" | grep -Eqx '[A-Za-z0-9._-]{1,100}' || ! printf '%s' "$instance" | grep -q '[^.]'; then
      instance="default"
    fi
  fi
  if ! mkdir -p "$workspace/instances/$instance" 2>/dev/null || [ ! -w "$workspace/instances/$instance" ]; then
    echo "sre-agent-fix-runner: the instance directory ${workspace}/instances/${instance} does not exist or is not writable by uid $(id -u), and with SRE_WORKSPACE_PER_INSTANCE=1 this runner keeps its own directories under it; mount the workspace writable, or point SRE_WORKSPACE somewhere this account owns" >&2
    exit 1
  fi
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
  case "$setup" in
    /*) ;;
    *)
      echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, which is not an absolute path; name a file in the image" >&2
      exit 1
      ;;
  esac
  # The script runs as root at every start, so it must be somewhere the agent
  # cannot write, whichever way the path is spelled. Three questions are asked
  # of the path as given and of the file it resolves to (a link can sit in a
  # place the agent writes while pointing at a safe file, and the other way
  # round): is it on the workspace, which is the volume the agent writes (its
  # home and checkouts live there); is it under one of the directories every
  # account can write, named here because they are where an agent looks first;
  # and is any directory above it, or the file itself, one the agent's account
  # can write, which covers the ones nobody named (a mount with the wrong mode).
  #
  # "Can write" is a question about the agent's uid and gid, not about the mode
  # alone: the account owns it, or its group can write it, or anyone can, except
  # in a sticky directory, where only an entry's owner can replace or remove it.
  # The mount point of a ConfigMap or projected volume is a world-writable
  # sticky directory on a read-only volume holding root-owned links and files,
  # so a script mounted there, the natural way, is out of the agent's reach and
  # is accepted; the same mode on a directory the agent owns is not. The
  # agent's supplementary groups are cleared when it is started, so only its
  # primary group counts.
  setup_given="$(realpath -m -s -- "$setup")"
  setup_real="$(realpath -e -- "$setup")"
  open_dirs=(/tmp /var/tmp /dev/shm /run/lock /var/lock)
  for candidate in "$setup_given" "$setup_real"; do
    case "$candidate/" in
      "$workspace_real"/*)
        echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, which is on the workspace ${workspace}; the agent can write there and the script runs as root, so put it in the image" >&2
        exit 1
        ;;
    esac
    for open_dir in "${open_dirs[@]}"; do
      open_real="$(realpath -m -- "$open_dir")"
      case "$candidate/" in
        "$open_dir"/* | "$open_real"/*)
          echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, which is under ${open_dir}; the agent can write there and the script runs as root, so put it in the image" >&2
          exit 1
          ;;
      esac
    done
  done
  # The directories above each spelling, and the resolved file itself. A link is
  # never the file asked about (its own mode says nothing), so the given spelling
  # starts at its directory and the resolved one at the file.
  for start in "${setup_given%/*}" "$setup_real"; do
    current="${start:-/}"
    while :; do
      read -r mode owner group < <(stat -L -c '%a %u %g' -- "$current" 2>/dev/null || echo "0 0 0")
      bits=$((8#${mode}))
      sticky_dir=0
      if [ -d "$current" ] && (( bits & 8#1000 )); then sticky_dir=1; fi
      reason=""
      if [ "$owner" = "$SRE_AGENT_UID" ]; then
        reason="owned by the agent account"
      elif (( bits & 8#002 )) && [ "$sticky_dir" = 0 ]; then
        reason="writable by every account"
      elif (( bits & 8#020 )) && [ "$group" = "$SRE_AGENT_GID" ] && [ "$sticky_dir" = 0 ]; then
        reason="writable by the agent's group"
      fi
      if [ -n "$reason" ]; then
        echo "sre-agent-fix-runner: SRE_RUNNER_SETUP names ${setup}, and ${current} on the way to it is ${reason}; the agent can replace what is there and the script runs as root, so put it in a place only root writes, in the image" >&2
        exit 1
      fi
      if [ "$current" = "/" ]; then break; fi
      current="${current%/*}"
      current="${current:-/}"
    done
  done
  # Last, after where it is: a script in a place the agent writes is refused for
  # that reason even when the place is also mounted noexec (/run/lock often is).
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
