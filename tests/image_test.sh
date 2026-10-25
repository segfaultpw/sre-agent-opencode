#!/usr/bin/env bash
# The container image and the entrypoint every install starts through.
#
# Two subjects, because they are one promise: the image carries the tools the
# runner shells out to, and the entrypoint refuses to start when one of them,
# or one of the three variables, is absent. A runner that starts anyway looks
# healthy and fails every job, and the first failure a customer sees is on a
# real fix request.
#
# The Dockerfile assertions are on what the image is built to carry rather than
# on a built image: building both architectures belongs in CI, and this script
# runs everywhere the other ten do.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/.."
dockerfile="$pkg/runner/Dockerfile"
entrypoint="$pkg/runner/entrypoint.sh"
ci="$pkg/.github/workflows/ci.yml"
release="$pkg/.github/workflows/release.yml"
# Written with the owner as an expression so a fork publishes to its own
# namespace; in this repository it resolves to ghcr.io/segfaultpw.
image='ghcr.io/${{ github.repository_owner }}/sre-agent-opencode-runner'
fail=0

for f in "$dockerfile" "$entrypoint"; do
  if [ -f "$f" ]; then echo "ok   $(basename "$f") exists"; else echo "FAIL $f is missing"; exit 1; fi
done

check() {
  local file="$1" pattern="$2" label="$3"
  if grep -qF -- "$pattern" "$file"; then echo "ok   $label"; else echo "FAIL $label: '$pattern' not in $(basename "$file")"; fail=1; fi
}

echo "--- the image carries the package and the clients the diagnosis needs ---"
for path in VERSION config agents scripts runner; do
  check "$dockerfile" "COPY ${path} /opt/sre-agent-opencode/${path}" "the image copies ${path} in"
done
check "$dockerfile" 'chmod -R go-w /opt/sre-agent-opencode' 'the package is not writable by the account the agent runs under'
# Two accounts, and the container's PID 1 is root only so that the runner can
# start every agent run as the other one (runner/runner.js, "Who runs what").
# The runner process is root in the container and never on a host: the systemd
# unit starts it as an unprivileged account holding a few capabilities.
check "$dockerfile" 'groupadd --gid 10001 runner' 'the runner account has a fixed id, so a mounted volume can be chowned to it'
check "$dockerfile" 'useradd --uid 10001 --gid runner' 'the runner account is created with that id'
check "$dockerfile" 'groupadd --gid 10002 agent' 'the agent has a group of its own'
check "$dockerfile" 'useradd --uid 10002 --gid agent' 'the agent account is a second, unprivileged account'
check "$dockerfile" '--home-dir /workspace/agent-home --no-create-home' 'the agent home is on the workspace volume, so what it installs there survives between requests (the runner creates and closes it at start)'
check "$dockerfile" 'chmod 0700 /home/runner' 'the runner home is closed to every other account'
check "$dockerfile" 'chmod 0711 /workspace' 'the workspace can be walked through but not listed by the agent'
check "$dockerfile" 'ARG MISE_VERSION=' 'mise is pinned to a version, so the agent can install language runtimes as itself without root'
check "$dockerfile" 'mise-v${MISE_VERSION}-linux-${arch}' 'mise is downloaded from its release for the architecture being built'
check "$dockerfile" '/usr/local/bin/mise' 'mise is on the PATH of every account, root-owned and not writable by the agent'
check "$dockerfile" 'mise --version' 'mise is installed and proved at build time'
check "$dockerfile" 'ENV SRE_RUNNER_USER=runner' 'the entrypoint is told which account the runner files belong to'
check "$dockerfile" 'ENV SRE_AGENT_USER=agent' 'the entrypoint is told which account the agent runs as'
for deb in build-essential python3 python3-pip python3-venv make xz-utils; do
  check "$dockerfile" "        ${deb} \\" "the base toolset has ${deb}, so a typical repository builds and tests without a setup script"
done
check "$dockerfile" 'util-linux' 'setpriv, which a runner without root starts the agent through, is installed by name'
check "$dockerfile" 'USER root' 'the container starts as root, which the runner needs to start the agent as another account'
if ! grep -qE '^USER (runner|agent|[0-9]+)' "$dockerfile"; then echo "ok   no later USER line takes root away from the entrypoint"; else echo "FAIL a USER line other than root remains in the Dockerfile"; fail=1; fi
check "$dockerfile" 'ENTRYPOINT ["/opt/sre-agent-opencode/runner/entrypoint.sh"]' 'the image starts through the entrypoint'
check "$dockerfile" 'kubectl version --client' 'kubectl is installed and proved at build time'
check "$dockerfile" 'aws --version' 'the AWS CLI is installed and proved at build time'
check "$dockerfile" 'gh --version' 'gh is installed and proved at build time'
check "$dockerfile" 'opencode --version' 'opencode is installed and proved at build time'
check "$dockerfile" 'sha256sum -c -' 'a download is checked against a digest rather than taken on its name'
check "$dockerfile" 'ENV OPENCODE_DISABLE_AUTOUPDATE=1' 'no opencode in the image can replace the binary that enforces the fences'
check "$dockerfile" '        bash \' 'bash is installed by name rather than inherited from the base'

# Two builds of one VERSION have to be the same binaries, because the version
# the image carries is stamped into every pull request body it opens. So the
# base is pinned by digest and every client by version and by content.
if grep -qE '^FROM .*@sha256:[0-9a-f]{64}$' "$dockerfile"; then
  echo "ok   the base image is pinned by digest rather than by a tag that moves"
else
  echo "FAIL the base image is pinned by tag, so two builds of one VERSION are not the same image"; fail=1
fi
downloads="$(grep -cE 'curl -fsSL -o' "$dockerfile" || true)"
digests="$(grep -cE 'sha256sum -c -' "$dockerfile" || true)"
if [ "$digests" -ge 4 ]; then
  echo "ok   opencode, kubectl, the AWS CLI and gh are each checked against a digest (${digests} checks over ${downloads} downloads)"
else
  echo "FAIL only ${digests} downloads are digest checked; one of the four clients is taken on its name alone"; fail=1
fi
for pinned in OPENCODE KUBECTL AWSCLI GH; do
  check "$dockerfile" "ARG ${pinned}_VERSION=" "${pinned} is pinned to a version rather than to whatever is current"
done

# The stamp on a pull request says which fences answered the request, so the
# binary in the image and the binary the reusable workflow's action installs
# have to be the same release.
dockerfile_opencode="$(sed -n 's/^ARG OPENCODE_VERSION=\(.*\)$/\1/p' "$dockerfile")"
action_opencode="$(sed -n 's#.*anomalyco/opencode/github@v\([0-9.]*\).*#\1#p' "$pkg/.github/workflows/fix.yml" | head -n 1)"
if [ -n "$dockerfile_opencode" ] && [ "$dockerfile_opencode" = "$action_opencode" ]; then
  echo "ok   the image pins the opencode release the reusable workflow is pinned at (${dockerfile_opencode})"
else
  echo "FAIL the image pins opencode '${dockerfile_opencode}' and fix.yml pins '${action_opencode}'"; fail=1
fi

# The x64 baseline build is a decision, not an accident: opencode's installer
# picks the AVX2 build from the build machine's /proc/cpuinfo, which is not the
# machine that will run the image.
check "$dockerfile" 'linux-x64-baseline' 'the amd64 build is the baseline one, which runs on any x86-64 machine'

echo "--- the entrypoint refuses rather than starting without its configuration ---"
work="$(mktemp -d)"
# The setup scripts live apart from $work: that is under /tmp, which the entrypoint
# refuses as a place for a script that runs as root, so a script placed there
# would be refused for that reason and prove nothing about the others.
setup_dir="$(mktemp -d "${HOME:-/root}/.sre-image-test-setup.XXXXXX")"
trap 'rm -rf "$work" "$setup_dir"' EXIT
mkdir -p "$work/bin" "$work/workspace"

# The account lookups of a root start, answered from a table: runner 10001,
# agent 10002, nothing else. FAKE_ID_U is the caller's own uid.
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then echo "${FAKE_ID_U:-1000}"; exit 0; fi
if [ "$#" -eq 1 ] && [ "$1" = "-g" ]; then echo "${FAKE_ID_U:-1000}"; exit 0; fi
case "$2" in
  runner) uid=10001 ;;
  agent) uid=10002 ;;
  *) exit 1 ;;
esac
echo "$uid"
EOF
cat > "$work/bin/getent" <<'EOF'
#!/usr/bin/env bash
case "$2" in
  runner) echo "runner:x:10001:10001::/home/runner:/usr/sbin/nologin" ;;
  agent) echo "agent:x:10002:10002::/workspace/agent-home:/usr/sbin/nologin" ;;
  *) exit 2 ;;
esac
EOF
cat > "$work/bin/setpriv" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
# A test cannot chown to uid 10002 without privilege, so the one lookup the
# entrypoint makes of a file's owner and group is answered from the name: a path
# with agent-owned in it belongs to the agent's uid, one with agent-group in it
# to the agent's group. Every other path, and every other call, is the real stat.
cat > "$work/bin/stat" <<'STATEOF'
#!/usr/bin/env bash
real=/usr/bin/stat
if [ "$#" -eq 5 ] && [ "$1" = -L ] && [ "$2" = -c ] && [ "$3" = '%a %u %g' ] && [ "$4" = -- ]; then
  read -r mode uid gid < <("$real" -L -c '%a %u %g' -- "$5") || exit 1
  case "$5" in *agent-owned*) uid=10002 ;; esac
  case "$5" in *agent-group*) gid=10002 ;; esac
  echo "$mode $uid $gid"
else
  exec "$real" "$@"
fi
STATEOF
chmod +x "$work/bin/id" "$work/bin/getent" "$work/bin/setpriv" "$work/bin/stat"

# Stands in for every command the entrypoint checks for. node also records the
# argv it was execed with, which is how a case proves the runner was started
# rather than merely not refused.
for tool in node git gh opencode; do
  cat > "$work/bin/$tool" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$STUB_LOG"
printf 'env: runner=%s:%s:%s agent=%s:%s:%s\n' "\${SRE_RUNNER_UID-}" "\${SRE_RUNNER_GID-}" "\${SRE_RUNNER_HOME-}" "\${SRE_AGENT_UID-}" "\${SRE_AGENT_GID-}" "\${SRE_AGENT_HOME-}" >> "\$STUB_LOG"
EOF
  chmod +x "$work/bin/$tool"
done
export STUB_LOG="$work/stub.log"

run_entrypoint() {
  : > "$STUB_LOG"
  rc=0
  out="$(env PATH="$work/bin:$PATH" \
    SRE_SERVER_URL="${SRE_SERVER_URL_V-https://app.example.invalid}" \
    SRE_API_KEY="${SRE_API_KEY_V-not-a-real-key}" \
    SRE_MODEL="${SRE_MODEL_V-openrouter/deepseek/deepseek-v4-pro}" \
    SRE_WORKSPACE="${SRE_WORKSPACE_V-$work/workspace}" \
    bash "$entrypoint" 2>&1)" || rc=$?
}

run_entrypoint
if [ "$rc" -eq 0 ]; then echo "ok   a configured runner starts"; else echo "FAIL a configured runner exited $rc: $out"; fail=1; fi
if grep -qF "runner/runner.js" "$STUB_LOG"; then echo "ok   it starts the runner itself"; else echo "FAIL node was execed with '$(cat "$STUB_LOG")'"; fail=1; fi

for var in SRE_SERVER_URL SRE_API_KEY SRE_MODEL; do
  eval "export ${var}_V=''"
  run_entrypoint
  eval "unset ${var}_V"
  if [ "$rc" -ne 0 ]; then echo "ok   a missing ${var} refuses to start"; else echo "FAIL an empty ${var} started anyway"; fail=1; fi
  if grep -qF "$var" <<<"$out"; then echo "ok   the refusal names ${var}"; else echo "FAIL the refusal does not name ${var}: $out"; fail=1; fi
  if [ ! -s "$STUB_LOG" ]; then echo "ok   nothing is started when ${var} is missing"; else echo "FAIL the runner was started anyway: $(cat "$STUB_LOG")"; fail=1; fi
done

# All three at once, which is what an operator who started the image with no
# environment at all actually sees.
export SRE_SERVER_URL_V='' SRE_API_KEY_V='' SRE_MODEL_V=''
run_entrypoint
unset SRE_SERVER_URL_V SRE_API_KEY_V SRE_MODEL_V
for var in SRE_SERVER_URL SRE_API_KEY SRE_MODEL; do
  if grep -qF "${var} is not set" <<<"$out"; then echo "ok   an unconfigured start names ${var}"; else echo "FAIL ${var} is not named: $out"; fail=1; fi
done

# The value of a credential must not be echoed by the thing that reports it is
# missing, and must not be echoed when it is present either.
SRE_API_KEY_V="$(printf 'sre-agent-poll-%048d' 4)"
export SRE_API_KEY_V SRE_MODEL_V=''
run_entrypoint
if ! grep -qF "$SRE_API_KEY_V" <<<"$out"; then echo "ok   a refusal prints no credential"; else echo "FAIL the refusal printed the API key"; fail=1; fi
unset SRE_API_KEY_V SRE_MODEL_V

# A missing tool is found before a job is collected rather than after a
# checkout, a model call and a push. PATH holds nothing but the three stubs
# that remain, which is also why the entrypoint locates itself without calling
# an external command.
mkdir -p "$work/partial"
for tool in node git opencode; do cp "$work/bin/$tool" "$work/partial/$tool"; done
bash_bin="$(command -v bash)"
: > "$STUB_LOG"
rc=0
out="$(env PATH="$work/partial" \
  SRE_SERVER_URL=https://app.example.invalid SRE_API_KEY=not-a-real-key \
  SRE_MODEL=openrouter/deepseek/deepseek-v4-pro SRE_WORKSPACE="$work/workspace" \
  "$bash_bin" "$entrypoint" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a missing gh refuses to start"; else echo "FAIL a missing gh started anyway"; fail=1; fi
if grep -qF "gh is not on PATH" <<<"$out"; then echo "ok   the refusal names the tool that is missing"; else echo "FAIL the refusal does not name gh: $out"; fail=1; fi
if [ ! -s "$STUB_LOG" ]; then echo "ok   nothing is started when a tool is missing"; else echo "FAIL the runner was started anyway: $(cat "$STUB_LOG")"; fail=1; fi

# A workspace that cannot be created is the same class of failure: the runner
# would collect a job and fail it at the checkout. The path is under a regular
# file, so mkdir cannot create it for any user, root included.
: > "$work/afile"
export SRE_WORKSPACE_V="$work/afile/workspace"
run_entrypoint
unset SRE_WORKSPACE_V
if [ "$rc" -ne 0 ]; then echo "ok   an unusable workspace refuses to start"; else echo "FAIL an unusable workspace started anyway"; fail=1; fi
if grep -qF "$work/afile/workspace" <<<"$out"; then echo "ok   the refusal names the workspace it could not use"; else echo "FAIL the refusal does not name the path: $out"; fail=1; fi
if [ ! -s "$STUB_LOG" ]; then echo "ok   nothing is started when the workspace is unusable"; else echo "FAIL the runner was started anyway: $(cat "$STUB_LOG")"; fail=1; fi

echo "--- a root start resolves the two accounts, and a start that cannot is refused ---"
run_as() {
  : > "$STUB_LOG"
  rc=0
  out="$(env PATH="$work/bin:$PATH" "$@" \
    SRE_SERVER_URL=https://app.example.invalid SRE_API_KEY=not-a-real-key \
    SRE_MODEL=openrouter/deepseek/deepseek-v4-pro SRE_WORKSPACE="$work/workspace" \
    bash "$entrypoint" 2>&1)" || rc=$?
}
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent
if [ "$rc" -eq 0 ] && grep -qxF 'env: runner=10001:10001:/home/runner agent=10002:10002:/workspace/agent-home' "$STUB_LOG"; then echo "ok   as root it hands the runner both accounts' ids and homes"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=nobody-here
if [ "$rc" -ne 0 ] && grep -qF 'nobody-here' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   as root a missing agent account refuses to start, naming it"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=agent SRE_AGENT_USER=agent
if [ "$rc" -ne 0 ] && grep -qF 'different accounts' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   as root one account for both refuses to start"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=1000 SRE_AGENT_USER=agent
if [ "$rc" -eq 0 ] && grep -qxF 'env: runner=:: agent=10002:10002:/workspace/agent-home' "$STUB_LOG"; then echo "ok   without root, a named agent account is resolved and the runner keeps its own"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
mkdir -p "$work/nosetpriv"
for tool in node git gh opencode id getent; do cp "$work/bin/$tool" "$work/nosetpriv/$tool"; done
: > "$STUB_LOG"
rc=0
out="$(env PATH="$work/nosetpriv" SRE_AGENT_USER=agent FAKE_ID_U=1000 \
  SRE_SERVER_URL=https://app.example.invalid SRE_API_KEY=not-a-real-key \
  SRE_MODEL=openrouter/deepseek/deepseek-v4-pro SRE_WORKSPACE="$work/workspace" \
  "$bash_bin" "$entrypoint" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'setpriv' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   a split without root needs setpriv and says so"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=1000
if [ "$rc" -eq 0 ] && grep -qxF 'env: runner=:: agent=::' "$STUB_LOG"; then echo "ok   without root and without an agent account nothing is resolved (the runner warns in its own log)"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi

echo "--- SRE_RUNNER_SETUP runs once as root before the runner starts, and a failure stops the start ---"
cat > "$setup_dir/ok.sh" <<EOF
#!/usr/bin/env bash
printf 'setup ran\\n' >> "$STUB_LOG"
printf 'setup sees SRE_API_KEY=%s SRE_GITHUB_TOKEN=%s\\n' "\${SRE_API_KEY-unset}" "\${SRE_GITHUB_TOKEN-unset}" >> "$STUB_LOG"
printf 'setup sees SRE_AGENT_GITHUB_TOKEN=%s OPENROUTER_API_KEY=%s AWS_SECRET_ACCESS_KEY=%s\\n' "\${SRE_AGENT_GITHUB_TOKEN-unset}" "\${OPENROUTER_API_KEY-unset}" "\${AWS_SECRET_ACCESS_KEY-unset}" >> "$STUB_LOG"
printf 'setup keeps SRE_SETUP_CHANNEL=%s HTTPS_PROXY=%s HOME=%s\\n' "\${SRE_SETUP_CHANNEL-unset}" "\${HTTPS_PROXY-unset}" "\${HOME-unset}" >> "$STUB_LOG"
echo "installing the extra package"
echo "a warning" >&2
EOF
cat > "$setup_dir/fail.sh" <<'EOF'
#!/usr/bin/env bash
echo "apt-get could not reach the mirror" >&2
exit 3
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$setup_dir/not-executable.sh"
chmod +x "$setup_dir/ok.sh" "$setup_dir/fail.sh"

run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent
if ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   with no SRE_RUNNER_SETUP nothing runs"; else echo "FAIL a setup ran with none named"; fail=1; fi

run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/ok.sh" \
  SRE_GITHUB_TOKEN=runner-token-value SRE_AGENT_GITHUB_TOKEN=agent-token-value OPENROUTER_API_KEY=provider-key-value \
  AWS_SECRET_ACCESS_KEY=aws-secret-value SRE_SETUP_CHANNEL=stable HTTPS_PROXY=http://proxy.example.invalid:3128
if [ "$rc" -eq 0 ] && [ "$(grep -cx 'setup ran' "$STUB_LOG")" -eq 1 ]; then echo "ok   the setup script runs once"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
setup_line="$(grep -nx 'setup ran' "$STUB_LOG" | head -n 1 | cut -d: -f1)"
runner_line="$(grep -n 'runner/runner.js' "$STUB_LOG" | head -n 1 | cut -d: -f1)"
if [ -n "$setup_line" ] && [ -n "$runner_line" ] && [ "$setup_line" -lt "$runner_line" ]; then echo "ok   it runs before the runner starts, so before the first poll"; else echo "FAIL setup at line '$setup_line', runner at line '$runner_line'"; fail=1; fi
if grep -qx 'setup sees SRE_API_KEY=unset SRE_GITHUB_TOKEN=unset' "$STUB_LOG"; then echo "ok   it is not given the runner's poll key or repository token"; else echo "FAIL $(grep 'setup sees' "$STUB_LOG")"; fail=1; fi
if grep -qx 'setup sees SRE_AGENT_GITHUB_TOKEN=unset OPENROUTER_API_KEY=unset AWS_SECRET_ACCESS_KEY=unset' "$STUB_LOG"; then echo "ok   it is not given the agent token, a model provider key or AWS credentials either: its environment is an allowlist"; else echo "FAIL $(grep 'setup sees' "$STUB_LOG")"; fail=1; fi
if grep -qx 'setup keeps SRE_SETUP_CHANNEL=stable HTTPS_PROXY=http://proxy.example.invalid:3128 HOME=/root' "$STUB_LOG"; then echo "ok   it keeps the operator's SRE_SETUP_* variables and the proxy, with root's home"; else echo "FAIL $(grep 'setup keeps' "$STUB_LOG")"; fail=1; fi
if grep -qF 'setup: installing the extra package' <<<"$out" && grep -qF 'setup: a warning' <<<"$out"; then echo "ok   its output, standard output and standard error, is logged"; else echo "FAIL output: $out"; fail=1; fi

run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/fail.sh"
if [ "$rc" -ne 0 ] && grep -qF 'exited 3' <<<"$out" && grep -qF "$setup_dir/fail.sh" <<<"$out" && grep -qF 'did not start' <<<"$out"; then echo "ok   a failing setup script stops the start and the log says which script and how it failed"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
if grep -qF 'apt-get could not reach the mirror' <<<"$out" && ! grep -q 'runner/runner.js' "$STUB_LOG"; then echo "ok   the script's own error is in the log and the runner never started"; else echo "FAIL out=$out log=$(cat "$STUB_LOG")"; fail=1; fi

run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/missing.sh"
if [ "$rc" -ne 0 ] && grep -qF "$setup_dir/missing.sh" <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   a setup script that does not exist stops the start"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/not-executable.sh"
if [ "$rc" -ne 0 ] && grep -qF 'not executable' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   one that is not executable stops the start"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
mkdir -p "$work/workspace/agent-home"
cp "$setup_dir/ok.sh" "$work/workspace/agent-home/setup.sh"
ln -sf "$work/workspace/agent-home/setup.sh" "$setup_dir/link-into-workspace.sh"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$work/workspace/agent-home/setup.sh"
if [ "$rc" -ne 0 ] && grep -qF 'on the workspace' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a setup script on the workspace (which the agent writes) is refused"; else echo "FAIL rc=$rc out=$out"; fail=1; fi

echo "--- SRE_WORKSPACE_PER_INSTANCE=1 creates this instance's directory before the runner starts ---"
run_entrypoint_split() {
  : > "$STUB_LOG"
  rc=0
  out="$(env PATH="$work/bin:$PATH" \
    SRE_SERVER_URL="${SRE_SERVER_URL_V-https://app.example.invalid}" \
    SRE_API_KEY="${SRE_API_KEY_V-not-a-real-key}" \
    SRE_MODEL="${SRE_MODEL_V-openrouter/deepseek/deepseek-v4-pro}" \
    SRE_WORKSPACE="${SRE_WORKSPACE_V-$work/workspace}" \
    "$@" bash "$entrypoint" 2>&1)" || rc=$?
}
run_entrypoint_split SRE_WORKSPACE_PER_INSTANCE=1 SRE_RUNNER_INSTANCE=pool-a
if [ "$rc" -eq 0 ] && [ -d "$work/workspace/instances/pool-a" ] && grep -qF 'runner/runner.js' "$STUB_LOG"; then echo "ok   the entrypoint creates the instance's own directory and starts the runner"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
rm -rf "$work/workspace/instances"
: > "$work/workspace/instances"
run_entrypoint_split SRE_WORKSPACE_PER_INSTANCE=1 SRE_RUNNER_INSTANCE=pool-a
if [ "$rc" -ne 0 ] && grep -qF 'instances/pool-a' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   a workspace that cannot hold the instance directory refuses to start, naming it, and starts nothing"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
rm -f "$work/workspace/instances"
run_entrypoint_split SRE_WORKSPACE_PER_INSTANCE=1 SRE_RUNNER_INSTANCE='bad name!'
if [ "$rc" -eq 0 ] && [ -d "$work/workspace/instances/$(hostname)" ] && grep -qF 'SRE_RUNNER_INSTANCE' <<<"$out" && grep -qF 'runner/runner.js' "$STUB_LOG"; then echo "ok   an instance name the runner cannot use falls back to the hostname, says so, and starts"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
rm -rf "$work/workspace/instances"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/link-into-workspace.sh"
if [ "$rc" -ne 0 ] && grep -qF 'on the workspace' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a link outside the workspace that points into it is refused too"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
relative_setup="$(realpath --relative-to="$PWD" "$setup_dir/ok.sh")"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$relative_setup"
if [ "$rc" -ne 0 ] && grep -qF 'not an absolute path' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a relative setup path is refused"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="https://example.invalid/setup.sh"
if [ "$rc" -ne 0 ] && grep -qF 'URL' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   a URL is refused: the runner never fetches a script"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=1000 SRE_RUNNER_SETUP="$setup_dir/ok.sh"
if [ "$rc" -ne 0 ] && grep -qF 'root' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   a start that is not root refuses a setup script rather than running it as somebody else"; else echo "FAIL rc=$rc out=$out"; fail=1; fi

echo "--- a setup script is never run from a place the agent can write ---"
# /tmp, /var/tmp and /dev/shm are writable by every account in the container,
# the agent's included, and the script runs as root at the next start.
for dir in /tmp /var/tmp /dev/shm; do
  if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then echo "ok   skipped: $dir is not a writable directory here"; continue; fi
  planted="$(mktemp -d "$dir/sre-image-test.XXXXXX")"
  printf '#!/usr/bin/env bash\nprintf "setup ran\\n" >> "%s"\n' "$STUB_LOG" > "$planted/setup.sh"
  chmod +x "$planted/setup.sh"
  run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$planted/setup.sh"
  if [ "$rc" -ne 0 ] && grep -qF "is under ${dir}" <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG" && ! grep -q 'runner/runner.js' "$STUB_LOG"; then echo "ok   a setup script under ${dir} is refused, and neither it nor the runner starts"; else echo "FAIL ${dir}: rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
  link_name="link-into-$(basename "$dir").sh"
  ln -sf "$planted/setup.sh" "$setup_dir/$link_name"
  run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/$link_name"
  if [ "$rc" -ne 0 ] && grep -qF "is under ${dir}" <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a link in the image that points under ${dir} is refused too"; else echo "FAIL link to ${dir}: rc=$rc out=$out"; fail=1; fi
  rm -rf "$planted"
done
# The same two reasons for every directory any account can write, not only the
# three above: /run/lock is one on Debian, and so is whatever an operator mounts
# with the wrong mode. The rule is read off the path as given and the path it
# resolves to, every directory above it, and the file itself.
for dir in /run/lock /var/lock; do
  if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then echo "ok   skipped: $dir is not a writable directory here"; continue; fi
  planted="$(mktemp -d "$dir/sre-image-test.XXXXXX")"
  printf '#!/usr/bin/env bash\nprintf "setup ran\\n" >> "%s"\n' "$STUB_LOG" > "$planted/setup.sh"
  chmod +x "$planted/setup.sh"
  run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$planted/setup.sh"
  if [ "$rc" -ne 0 ] && grep -qE "is under ${dir}|writable by every account" <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a setup script under ${dir} is refused"; else echo "FAIL ${dir}: rc=$rc out=$out"; fail=1; fi
  rm -rf "$planted"
done
check "$entrypoint" '/run/lock /var/lock' 'the refusal names /run/lock and /var/lock whether or not this machine lets the test write there'

open_dir="$setup_dir/open"
mkdir -p "$open_dir/inner"
chmod 0777 "$open_dir"
cp "$setup_dir/ok.sh" "$open_dir/setup.sh"
cp "$setup_dir/ok.sh" "$open_dir/inner/setup.sh"
chmod 0755 "$open_dir/inner" "$open_dir/setup.sh" "$open_dir/inner/setup.sh"
ln -sf "$setup_dir/ok.sh" "$open_dir/link.sh"
cp "$setup_dir/ok.sh" "$setup_dir/world-writable.sh"
chmod 0757 "$setup_dir/world-writable.sh"
ln -sf "$open_dir" "$setup_dir/open-link"
for case_name in directly nested link inlink file; do
  case "$case_name" in
    directly) target="$open_dir/setup.sh"; what="a script in a directory every account can write" ;;
    nested) target="$open_dir/inner/setup.sh"; what="a script whose directory is private but whose parent is writable by every account" ;;
    link) target="$open_dir/link.sh"; what="a link that sits in a directory every account can write, though it points at a safe file" ;;
    inlink) target="$setup_dir/open-link/setup.sh"; what="a script reached through a link to a directory every account can write" ;;
    file) target="$setup_dir/world-writable.sh"; what="a script that every account can write" ;;
  esac
  run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$target"
  if [ "$rc" -ne 0 ] && grep -qF 'writable by every account' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG" && ! grep -q 'runner/runner.js' "$STUB_LOG"; then echo "ok   ${what} is refused, and neither it nor the runner starts"; else echo "FAIL ${case_name}: rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
done
ln -sf "$setup_dir/ok.sh" "$setup_dir/safe-link.sh"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/safe-link.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a link in a private directory to a private script still runs"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
for spelling in / // /./ /../; do
  : > "$STUB_LOG"
  rc=0
  out="$(env PATH="$work/bin:$PATH" FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/ok.sh" \
    SRE_SERVER_URL=https://app.example.invalid SRE_API_KEY=not-a-real-key \
    SRE_MODEL=openrouter/deepseek/deepseek-v4-pro SRE_WORKSPACE="$spelling" \
    bash "$entrypoint" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] && grep -qF 'workspace is /' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG" && ! grep -q 'runner/runner.js' "$STUB_LOG"; then echo "ok   a setup script with SRE_WORKSPACE=${spelling} (the whole file system) is refused"; else echo "FAIL SRE_WORKSPACE=${spelling}: rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
done
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$setup_dir/ok.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a script in a directory of its own, outside those, still runs"; else echo "FAIL rc=$rc out=$out"; fail=1; fi

echo "--- a setup script is refused when the agent's account can replace it, and only then ---"
# What the entrypoint asks is whether the agent can write the file or a directory
# above it: it owns it, its group can write it, or anyone can, except in a
# sticky directory, where only an entry's owner can replace it. The mount point
# of a ConfigMap is a world-writable sticky directory on a read-only volume,
# holding root-owned links (..data -> a timestamped directory) to root-owned
# files; mounting the script there is the natural way to supply one.
cm="$setup_dir/configmap"
mkdir -p "$cm/..2026_10_25_00_00_00.1234"
cp "$setup_dir/ok.sh" "$cm/..2026_10_25_00_00_00.1234/setup.sh"
chmod 0755 "$cm/..2026_10_25_00_00_00.1234" "$cm/..2026_10_25_00_00_00.1234/setup.sh"
ln -s ..2026_10_25_00_00_00.1234 "$cm/..data"
ln -s ..data/setup.sh "$cm/setup.sh"
chmod 1777 "$cm"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$cm/setup.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a script mounted from a ConfigMap (a sticky world-writable mount point, ..data links, root-owned files) runs"; else echo "FAIL a ConfigMap layout was refused: rc=$rc out=$out"; fail=1; fi
sticky="$setup_dir/sticky-open"
mkdir -p "$sticky"
cp "$setup_dir/ok.sh" "$sticky/setup.sh"
chmod 0755 "$sticky/setup.sh"
chmod 1777 "$sticky"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$sticky/setup.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a root-owned script in a sticky world-writable directory runs: the agent can add files there and cannot replace this one"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
agent_owned="$setup_dir/agent-owned"
mkdir -p "$agent_owned"
cp "$setup_dir/ok.sh" "$agent_owned/setup.sh"
chmod 0755 "$agent_owned" "$agent_owned/setup.sh"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$agent_owned/setup.sh"
if [ "$rc" -ne 0 ] && grep -qF 'owned by the agent account' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a script in a directory the agent account owns is refused, though no mode bit says so"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
chmod 1777 "$agent_owned"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$agent_owned/setup.sh"
if [ "$rc" -ne 0 ] && grep -qF 'owned by the agent account' <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   being sticky does not excuse a directory the agent owns"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
agent_group="$setup_dir/agent-group"
mkdir -p "$agent_group"
cp "$setup_dir/ok.sh" "$agent_group/setup.sh"
chmod 0755 "$agent_group/setup.sh"
chmod 0775 "$agent_group"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$agent_group/setup.sh"
if [ "$rc" -ne 0 ] && grep -qF "writable by the agent's group" <<<"$out" && ! grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   a directory the agent's group can write is refused"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
chmod 0755 "$agent_group"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$agent_group/setup.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   the same directory without group write runs"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
group_dir="$setup_dir/other-group-writable"
mkdir -p "$group_dir"
cp "$setup_dir/ok.sh" "$group_dir/setup.sh"
chmod 0755 "$group_dir/setup.sh"
chmod 0775 "$group_dir"
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=agent SRE_RUNNER_SETUP="$group_dir/setup.sh"
if [ "$rc" -eq 0 ] && grep -qx 'setup ran' "$STUB_LOG"; then echo "ok   write by some other group is no write by the agent, whose supplementary groups are cleared"; else echo "FAIL rc=$rc out=$out"; fail=1; fi

echo "--- the workflows build the image on both architectures ---"
# Every runs-on in this repository's own workflows reads the organization's
# runner switch, so a month's Actions minutes running out moves the job to
# another provider without a commit. fix.yml is deliberately not checked: it
# runs in a customer's repository, where these variables do not exist, and its
# runner input defaults to a label GitHub itself provides.
while IFS= read -r line; do
  case "$line" in
    *vars.RUNNER_* | *matrix.runner*) ;;
    *) echo "FAIL a hard-coded runner label: ${line}"; fail=1 ;;
  esac
done < <(grep -hE '^ *(runs-on|runner):' "$ci" "$release")
echo "ok   no runs-on in ci.yml or release.yml hard-codes a runner label"

check "$ci" 'file: runner/Dockerfile' 'CI builds the runner image'
check "$ci" 'platform: linux/amd64' 'CI builds amd64'
check "$ci" 'platform: linux/arm64' 'CI builds arm64'
check "$ci" 'vars.RUNNER_ARM64' 'the arm64 leg runs on a native arm64 runner'
check "$ci" 'push: false' 'CI builds the image without publishing it'
check "$ci" 'bash tests/image_test.sh' 'CI runs this test'

echo "--- CI checks the image as the account the agent runs as, and that it starts as root ---"
# The image starts as root (the Dockerfile's USER, pinned above), so a docker run
# with no --user is root: "not root" and "cannot write the fences" are both false
# there whatever the file modes say. The checks that mean something about the
# agent run as the agent, and the default is asserted separately.
step="$(awk '/- name: The image carries what the runner shells out to/ { found = 1; print; next } found && /^      - name:/ { exit } found { print }' "$ci")"
if grep -qF -- 'docker run --rm --user agent -e HOME=/tmp --entrypoint bash' <<<"$step"; then echo "ok   the in-container checks run with --user agent, with a HOME that account can write (its own is made by the runner at start)"; else echo "FAIL the in-container checks do not run as the agent account"; fail=1; fi
# shellcheck disable=SC2016 # the text searched for is the literal command in ci.yml
if grep -qF 'test "$(id -u)" -eq 10002' <<<"$step" && ! grep -qF -- '-ne 0' <<<"$step"; then echo "ok   they assert the uid is the agent's, not merely that it is not root"; else echo "FAIL the uid assertion is not the agent's: $(grep -n 'id -u' <<<"$step")"; fail=1; fi
if grep -qF '! test -w /opt/sre-agent-opencode/config/opencode.json' <<<"$step"; then echo "ok   they assert the fences are not writable by that account"; else echo "FAIL the writability assertion is gone"; fail=1; fi
if grep -qF "docker inspect -f '{{.Config.User}}' \"\$IMAGE\"" <<<"$step" && grep -qE '!= *"?root"?' <<<"$step"; then echo "ok   they assert the image's default user is root, which is what the Dockerfile pins and the runner needs"; else echo "FAIL the image's default user is not asserted"; fail=1; fi

start_step="$(awk '/- name: The image starts the runner and reaches its first poll/ { found = 1; print; next } found && /^      - name:/ { exit } found && /^  [a-z]/ { exit } found { print }' "$ci")"
if grep -qF 'docker run -d' <<<"$start_step" && grep -qF 'polling http://127.0.0.1:9' <<<"$start_step"; then echo "ok   CI starts the image and waits for its first poll, at a refused local port"; else echo "FAIL CI never starts the image past its configuration check"; fail=1; fi
if grep -qF -- '--user 10001:10001 --cap-drop ALL' <<<"$start_step" && grep -qF 'the agent account split is off' <<<"$start_step"; then echo "ok   it also starts it as a pod that drops every capability does, and expects the fallback sentence instead of a crash"; else echo "FAIL the no-capability start is not in CI"; fail=1; fi

if grep -qF -- '--cap-drop ALL' <<<"$start_step" && grep -qF 'the agent would run as root, so the runner will not start' <<<"$start_step"; then echo "ok   CI also starts it as root with every capability dropped and expects the refusal, never a start with the agent as root"; else echo "FAIL the root-without-capabilities refusal is not in CI"; fail=1; fi

echo "--- every runs-on fallback is the Blacksmith label the file's header says it is ---"
fallbacks="$(grep -hoE "vars\.RUNNER_[A-Z0-9]+ \|\| '[^']+'" "$ci" "$release" | sed -e "s/.*|| '//" -e "s/'\$//" | sort -u)"
if [ -n "$fallbacks" ] && ! grep -qv '^blacksmith-' <<<"$fallbacks"; then echo "ok   every fallback is a Blacksmith label ($(tr '\n' ' ' <<<"$fallbacks"))"; else echo "FAIL a fallback is not a Blacksmith label: $(grep -v '^blacksmith-' <<<"$fallbacks" | tr '\n' ' ')"; fail=1; fi

check "$release" "$image" 'the release publishes the runner image'
check "$release" 'push: true' 'the release publishes rather than only building'
check "$release" 'docker buildx imagetools create' 'the per-architecture tags are merged into one manifest'
check "$release" '"$IMAGE:$TAG-amd64"' 'the amd64 tag feeds the manifest'
check "$release" '"$IMAGE:$TAG-arm64"' 'the arm64 tag feeds the manifest'
check "$release" 'needs: [check, image-manifest]' 'a release is announced only after its image exists'

# The moving major is what an operator following "the latest v1" pulls, so a
# prerelease must not move it, exactly as the git tag is not moved.
major="$(awk '/name: Move the moving major image tag/ { found = 1; next } found && /^ *if:/ { print; exit }' "$release")"
if [[ "$major" == *"prerelease != 'true'"* ]]; then
  echo "ok   a prerelease does not move the major image tag"
else
  echo "FAIL the major image tag is not guarded by the prerelease check (got '${major}')"; fail=1
fi

exit $fail
