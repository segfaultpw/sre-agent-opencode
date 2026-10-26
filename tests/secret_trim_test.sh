#!/usr/bin/env bash
# The runner trims the whitespace around every secret it reads, and refuses one
# with a line break inside. A key pasted from a terminal or written with echo
# arrives with a trailing newline, which an Authorization header refuses and a
# credential helper sends as part of the secret; trimming at load is the one
# place that covers every use. The secrets are SRE_API_KEY, SRE_GITHUB_TOKEN,
# SRE_AGENT_GITHUB_TOKEN and the provider keys scripts/provider_env.sh names.
#
# The real runner runs against the fixture platform. The assertions are on what
# the platform received and on what the agent's stub saw, and on the words the
# refusal uses, which must never carry the value.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/.."
runner="$pkg/runner/runner.js"
fail=0

if command -v node >/dev/null 2>&1; then echo "ok   node is on PATH"; else echo "FAIL node is not on PATH"; exit 1; fi
if command -v jq >/dev/null 2>&1; then echo "ok   jq is on PATH"; else echo "FAIL jq is not on PATH"; exit 1; fi

work="$(mktemp -d)"
fixture_pid=""
# shellcheck disable=SC2329 # the EXIT trap below runs it
cleanup() {
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check() {
  local description="$1"
  shift
  if "$@"; then echo "ok   $description"; else echo "FAIL $description"; fail=1; fi
}

for name in $(env | cut -d= -f1 | grep -E '^(AWS_|ECS_CONTAINER|SRE_|OPENROUTER_|ANTHROPIC_|GH_|GITHUB_)' || true); do unset "$name"; done

# Assembled at run time, long enough that finding one in a log means something.
api_key="$(printf 'sre-agent-poll-%048d' 1)"
handoff_token="$(printf 'sre-agent-handoff-%048d' 2)"
github_token="$(printf 'sre-agent-github-%048d' 3)"
agent_token="$(printf 'sre-agent-agent-tok-%048d' 7)"
provider_key="$(printf 'sk-or-fixture-%048d' 8)"
model="openrouter/deepseek/deepseek-v4-pro"

mkdir -p "$work/bin" "$work/ws"
install -m 755 "$here/fixture/stub_opencode.sh" "$work/bin/opencode"
export PATH="$work/bin:$PATH"

brief_file="$work/brief.md"
queue_file="$work/queue.json"
opencode_log="$work/opencode.log"
printf '# Fix request\n\nThe checkout service refuses connections under load.\n' > "$brief_file"
export STUB_OPENCODE_LOG="$opencode_log" STUB_OPENCODE_MODE=diagnose STUB_EXPECT_GH_TOKEN="$agent_token"
export FIXTURE_PORT_FILE="$work/port" FIXTURE_API_KEY="$api_key"
export FIXTURE_HANDOFF_TOKEN="$handoff_token" FIXTURE_BRIEF_FILE="$brief_file"
export FIXTURE_QUEUE_FILE="$queue_file" FIXTURE_QUEUE_STATUSES=200

fixture_log="$work/requests.jsonl"
: > "$fixture_log"
FIXTURE_LOG="$fixture_log" node "$here/fixture/queue_server.js" &
fixture_pid=$!
waited=0
while [ ! -s "$work/port" ] && [ "$waited" -lt 200 ]; do
  sleep 0.05
  waited=$((waited + 1))
done
if [ ! -s "$work/port" ]; then echo "FAIL the fixture platform did not start"; exit 1; fi
server_url="http://127.0.0.1:$(cat "$work/port")"

queue_one() {
  jq -n --arg id "$1" --arg base "$server_url" --arg token "$handoff_token" \
    '[{handoff_id: $id, subject_id: "11111111-2222-3333-4444-555555555555", repo_full_name: null,
       brief_url: ($base + "/api/handoffs/" + $id + "/brief"), report_url: ($base + "/api/handoffs/" + $id + "/report"), token: $token}]' > "$queue_file"
}

rc=0
out=""
# run_runner <label> then NAME=value pairs that replace the defaults.
run_runner() {
  local label="$1"
  shift
  : > "$opencode_log"
  : > "$fixture_log"
  out="$work/$label.out"
  rc=0
  (cd "$work" && timeout 60 env SRE_ONCE=1 SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
    SRE_WORKSPACE="$work/ws" SRE_GITHUB_TOKEN="${runner_github_token-$github_token}" OPENROUTER_API_KEY="$provider_key" SRE_RUN_TIMEOUT_SECONDS=60 \
    "$@" node "$runner") > "$out" 2>&1 || rc=$?
}

echo "--- 1. whitespace around a secret is removed, so the platform and the agent see the secret alone ---"
queue_one h-trim
run_runner trimmed "SRE_API_KEY=${api_key}"$'\n' "SRE_GITHUB_TOKEN=  ${github_token}"$'\r\n' \
  "SRE_AGENT_GITHUB_TOKEN="$'\t'"${agent_token}"$'\n\n' "OPENROUTER_API_KEY= ${provider_key}"$'\n'
check "a runner whose secrets carry whitespace starts and answers" test "$rc" -eq 0 -a "$(jq -s '[.[] | select(.path | endswith("/report"))] | length' "$fixture_log")" -eq 1
check "the queue is polled with the key alone" test "$(jq -r 'select(.path == "/api/fix-runner/queue") | .authorization' "$fixture_log" | tail -n 1)" = "Bearer $api_key"
check "the agent's GH_TOKEN is the agent token alone" grep -qx 'gh_token: matches' "$opencode_log"
check "the agent's provider key is the key alone" grep -qxF "provider_key: [$provider_key]" "$opencode_log"
check "the log names what was trimmed" grep -qF 'removed the whitespace around SRE_API_KEY, SRE_GITHUB_TOKEN, SRE_AGENT_GITHUB_TOKEN, OPENROUTER_API_KEY' "$out"
check "and carries no secret" test -z "$(grep -F -e "$api_key" -e "$github_token" -e "$agent_token" -e "$provider_key" "$out" || true)"

echo "--- 1b. loadConfig hands back the trimmed values ---"
loaded="$(cd "$work" && env SRE_SERVER_URL="$server_url" SRE_API_KEY="${api_key}"$'\n' SRE_MODEL="$model" SRE_GITHUB_TOKEN=" ${github_token}"$'\n' \
  SRE_AGENT_GITHUB_TOKEN="${agent_token} " OPENROUTER_API_KEY=$'\n'"${provider_key}" node -e '
    const runner = require(process.argv[1]);
    const config = runner.loadConfig();
    console.log(JSON.stringify({ apiKey: config.apiKey, githubToken: config.githubToken, agentGithubToken: config.agentGithubToken, provider: process.env.OPENROUTER_API_KEY }));
  ' "$runner")"
check "the poll key is trimmed" test "$(jq -r '.apiKey' <<<"$loaded")" = "$api_key"
check "the runner's repository token is trimmed" test "$(jq -r '.githubToken' <<<"$loaded")" = "$github_token"
check "the agent's repository token is trimmed" test "$(jq -r '.agentGithubToken' <<<"$loaded")" = "$agent_token"
check "the provider key the agent inherits is trimmed" test "$(jq -r '.provider' <<<"$loaded")" = "$provider_key"

echo "--- 2. a line break inside a secret is refused at start, and the value is never printed ---"
for name in SRE_API_KEY SRE_GITHUB_TOKEN SRE_AGENT_GITHUB_TOKEN SRE_GITHUB_APP_ID OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
  first="before-$(printf '%s' "$name" | tr -c 'A-Za-z' 'x')-break"
  second="after-$(printf '%s' "$name" | tr -c 'A-Za-z' 'x')-break"
  queue_one "h-inner-$name"
  run_runner "inner_$name" "$name=${first}"$'\n'"${second}"
  check "$name with a line break inside refuses to start" test "$rc" -ne 0
  check "$name: the refusal names the variable and says why" grep -qF "$name has a line break inside its value" "$out"
  check "$name: neither half of the value is printed" test -z "$(grep -F -e "$first" -e "$second" "$out" || true)"
  check "$name: nothing was polled" test "$(jq -s 'length' "$fixture_log")" -eq 0
done
queue_one h-inner-cr
run_runner inner_cr "SRE_API_KEY=first-half"$'\r'"second-half"
check "a carriage return inside a secret is refused too" test "$rc" -ne 0 -a "$(grep -cF 'SRE_API_KEY has a line break inside its value' "$work/inner_cr.out")" -eq 1

echo "--- 2b. the App's private key is the one secret allowed line breaks inside ---"
app_pem_file="$work/app.pem"
node -e 'process.stdout.write(require("node:crypto").generateKeyPairSync("rsa", {modulusLength: 2048}).privateKey.export({type: "pkcs8", format: "pem"}))' > "$app_pem_file"
app_pem="$(cat "$app_pem_file")"
pem_wrapped="$(printf '\n  %s  \n' "$app_pem")"
rm -f "$queue_file"
runner_github_token=""
run_runner pem "SRE_GITHUB_APP_ID= 123456 " "SRE_GITHUB_APP_PRIVATE_KEY=$pem_wrapped"
runner_github_token="$github_token"
check "a PEM with line breaks inside starts in App mode" test "$rc" -eq 0
check "the trim log names the App variables, never a value" grep -qF 'removed the whitespace around SRE_GITHUB_APP_ID, SRE_GITHUB_APP_PRIVATE_KEY' "$out"
check "and carries no PEM and no line of it" test -z "$(grep -F -e "$app_pem" -e 'PRIVATE KEY' "$out" || true)"
pem_loaded="$(cd "$work" && env SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
  SRE_GITHUB_APP_ID=" 123456 " SRE_GITHUB_APP_PRIVATE_KEY="$pem_wrapped" node -e '
    const runner = require(process.argv[1]);
    const config = runner.loadConfig();
    console.log(JSON.stringify({ appId: config.githubApp && config.githubApp.appId, key: config.githubApp && config.githubApp.privateKey }));
  ' "$runner")"
check "the App id is trimmed to the number" test "$(jq -r '.appId' <<<"$pem_loaded")" = "123456"
check "the PEM keeps its internal line breaks" test "$(jq -r '.key' <<<"$pem_loaded")" = "$app_pem"

echo "--- 2c. a key that cannot sign refuses the start, naming the variable and never the value ---"
rm -f "$queue_file"
runner_github_token=""
run_runner pem-bad "SRE_GITHUB_APP_ID=123456" "SRE_GITHUB_APP_PRIVATE_KEY=not a pem at all"
runner_github_token="$github_token"
check "an unusable key refuses to start" test "$rc" -ne 0
check "the refusal names SRE_GITHUB_APP_PRIVATE_KEY" grep -qF 'SRE_GITHUB_APP_PRIVATE_KEY' "$out"
check "and prints no part of the value" test -z "$(grep -F "not a pem" "$out" || true)"
check "and nothing was polled" test "$(jq -s 'length' "$fixture_log")" -eq 0

echo "--- 3. a secret that is only whitespace counts as not set ---"
queue_one h-blank
run_runner blank "SRE_API_KEY="$'\n'
check "a blank poll key is reported as missing" test "$rc" -ne 0 -a "$(grep -cF 'SRE_API_KEY' "$work/blank.out")" -ge 1
check "and nothing was polled" test "$(jq -s 'length' "$fixture_log")" -eq 0

if [ "$fail" -ne 0 ]; then echo "secret_trim_test: FAILED"; exit 1; fi
echo "secret_trim_test: all checks passed"
