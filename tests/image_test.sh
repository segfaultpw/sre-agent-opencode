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
check "$dockerfile" '--home-dir /home/agent --create-home' 'the agent has a home of its own to keep opencode state in'
check "$dockerfile" 'chmod 0700 /home/runner /home/agent' 'both homes are closed to every other account'
check "$dockerfile" 'chmod 0711 /workspace' 'the workspace can be walked through but not listed by the agent'
check "$dockerfile" 'ENV SRE_RUNNER_USER=runner' 'the entrypoint is told which account the runner files belong to'
check "$dockerfile" 'ENV SRE_AGENT_USER=agent' 'the entrypoint is told which account the agent runs as'
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
trap 'rm -rf "$work"' EXIT
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
  agent) echo "agent:x:10002:10002::/home/agent:/usr/sbin/nologin" ;;
  *) exit 2 ;;
esac
EOF
cat > "$work/bin/setpriv" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/id" "$work/bin/getent" "$work/bin/setpriv"

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
if [ "$rc" -eq 0 ] && grep -qxF 'env: runner=10001:10001:/home/runner agent=10002:10002:/home/agent' "$STUB_LOG"; then echo "ok   as root it hands the runner both accounts' ids and homes"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=runner SRE_AGENT_USER=nobody-here
if [ "$rc" -ne 0 ] && grep -qF 'nobody-here' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   as root a missing agent account refuses to start, naming it"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=0 SRE_RUNNER_USER=agent SRE_AGENT_USER=agent
if [ "$rc" -ne 0 ] && grep -qF 'different accounts' <<<"$out" && [ ! -s "$STUB_LOG" ]; then echo "ok   as root one account for both refuses to start"; else echo "FAIL rc=$rc out=$out"; fail=1; fi
run_as FAKE_ID_U=1000 SRE_AGENT_USER=agent
if [ "$rc" -eq 0 ] && grep -qxF 'env: runner=:: agent=10002:10002:/home/agent' "$STUB_LOG"; then echo "ok   without root, a named agent account is resolved and the runner keeps its own"; else echo "FAIL rc=$rc out=$out log=$(cat "$STUB_LOG")"; fail=1; fi
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
