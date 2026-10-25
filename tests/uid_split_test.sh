#!/usr/bin/env bash
# The runner and the agent are different accounts, and this test proves it with
# real uids rather than by reading the code: the runner is started once as root
# (the container model) and once as an unprivileged account holding the few
# capabilities it needs (the systemd model), and the stub agent reports what it
# can and cannot reach from where it runs.
#
# Switching uids needs root. The test gets it, in order, from: being root,
# an unprivileged user namespace with a subuid range (no host privilege at all),
# or passwordless sudo. With none of the three it says so and exits 0, because
# a machine that cannot switch uids cannot be tested this way; CI has sudo.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  if ! command -v setpriv >/dev/null 2>&1; then echo "SKIP setpriv is not installed, so no uid can be switched"; exit 0; fi
  if [ ! -r "$(command -v node)" ] || [ ! -x "$(command -v node)" ]; then echo "SKIP node is not usable"; exit 0; fi
  if [ "$(id -u)" -eq 0 ]; then
    exec bash "$0" --inner
  elif unshare --user --map-users=auto --map-groups=auto --setuid 0 --setgid 0 setpriv --reuid=10001 --regid=10001 --clear-groups true 2>/dev/null; then
    exec unshare --user --map-users=auto --map-groups=auto --setuid 0 --setgid 0 bash "$0" --inner
  elif sudo -n true 2>/dev/null; then
    exec sudo -n env "PATH=$PATH" bash "$0" --inner
  fi
  echo "SKIP no way to become root here (not root, no user namespace with a subuid range, no passwordless sudo)"
  exit 0
fi

pkg="$here/.."
fail=0
runner_uid=10001
agent_uid=10002
caps_uid=10003
real_git="$(command -v git)"
work="$(mktemp -d)"
chmod 755 "$work"
# The accounts below cannot necessarily walk through the directory this
# checkout is in (a home directory is often 0750), so they run from a copy.
for item in VERSION config agents scripts runner tests/fixture; do
  mkdir -p "$work/pkg/$(dirname "$item")"
  cp -R "$pkg/$item" "$work/pkg/$item"
done
chmod -R a+rX "$work/pkg"
runner="$work/pkg/runner/runner.js"
fixture_dir="$work/pkg/tests/fixture"
survivors=()
fixture_pid=""
# shellcheck disable=SC2329 # the EXIT trap below runs it
cleanup() {
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  for pid in "${survivors[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

api_key="$(printf 'sre-agent-poll-%048d' 1)"
handoff_token="$(printf 'sre-agent-handoff-%048d' 2)"
github_token="$(printf 'sre-agent-github-%048d' 3)"
model="openrouter/deepseek/deepseek-v4-pro"
remote="$work/remote/app.git"
mkdir -p "$work/bin" "$work/remote" "$work/home"
"$real_git" init -q --bare -b main "$remote"
"$real_git" init -q -b main "$work/seed"
printf 'the fixture repository\n' > "$work/seed/README.md"
"$real_git" -C "$work/seed" add README.md
"$real_git" -C "$work/seed" -c user.name=seed -c user.email=seed@example.invalid -c commit.gpgsign=false commit -q -m "seed"
"$real_git" -C "$work/seed" push -q "$remote" main
chmod -R a+rX "$work/remote"

cat > "$work/brief.md" <<EOF
# Fix request

The service refuses connections under load.

<!-- sre-agent:remediation:99999999-8888-7777-6666-555555555555 -->
EOF

cat > "$work/bin/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id -u >> "\$FAKE_GIT_UID_LOG"
args=()
for a in "\$@"; do
  case "\$a" in
    https://*github.com/*) args+=("$remote") ;;
    *) args+=("\$a") ;;
  esac
done
exec "$real_git" "\${args[@]}"
EOF
cat > "$work/bin/gh" <<EOF
#!/usr/bin/env bash
id -u >> "\$FAKE_GH_UID_LOG"
printf '%s\n' "https://github.com/acme/app/pull/7"
EOF
install -m 755 "$fixture_dir/stub_opencode.sh" "$work/bin/opencode"
chmod 755 "$work/bin/git" "$work/bin/gh"

export PATH="$work/bin:$PATH"
export FIXTURE_PORT_FILE="$work/port" FIXTURE_API_KEY="$api_key" FIXTURE_HANDOFF_TOKEN="$handoff_token"
export FIXTURE_BRIEF_FILE="$work/brief.md" FIXTURE_QUEUE_FILE="$work/queue.json" FIXTURE_QUEUE_STATUSES=200

server_url=""
start_fixture() {
  rm -f "$work/port"
  FIXTURE_LOG="$work/requests.jsonl" node "$fixture_dir/queue_server.js" &
  fixture_pid=$!
  local waited=0
  while [ ! -s "$work/port" ] && [ "$waited" -lt 200 ]; do sleep 0.05; waited=$((waited + 1)); done
  if [ ! -s "$work/port" ]; then echo "FAIL the fixture platform did not start"; exit 1; fi
  server_url="http://127.0.0.1:$(cat "$work/port")"
}
stop_fixture() {
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
    fixture_pid=""
  fi
}

queue_job() {
  jq -n --arg id "$1" --arg repo "$2" --arg base "$server_url" --arg token "$handoff_token" \
    '[{handoff_id: $id, subject_id: "11111111-2222-3333-4444-555555555555",
       repo_full_name: (if $repo == "" then null else $repo end),
       brief_url: ($base + "/api/handoffs/" + $id + "/brief"),
       report_url: ($base + "/api/handoffs/" + $id + "/report"),
       token: $token}]' > "$work/queue.json"
}

# One pass of the runner for one mode. $1 is the label, $2 the account the
# runner's files belong to, and the rest is the command that starts the runner
# as that account (empty for root).
prove() {
  local label="$1" owner="$2"
  shift 2
  local ws="$work/$label-ws" probe="$work/$label.probe" survivor="$work/$label.survivor"
  local uidlog="$work/$label.git-uids" ghuidlog="$work/$label.gh-uids" out="$work/$label.out"
  local runner_home="$work/home/$label-runner" agent_home="$work/home/$label-agent"
  echo "--- $label ---"
  mkdir -p "$ws/memory/acme/app" "$ws/repos/acme/other" "$runner_home" "$agent_home"
  printf 'the earlier notes\n' > "$ws/memory/acme/app/NOTES.md"
  printf 'another repository, not the agent'"'"'s to touch\n' > "$ws/repos/acme/other/secret.txt"
  # Git refuses a repository another uid owns, so the remote belongs to the
  # account the runner's git calls run as.
  chown -R "$owner:$owner" "$ws" "$runner_home" "$work/remote"
  chmod 700 "$ws" "$ws/repos/acme/other"
  chown -R "$agent_uid:$agent_uid" "$agent_home"
  : > "$probe"; : > "$uidlog"; : > "$ghuidlog"; : > "$survivor"
  chmod 666 "$probe" "$uidlog" "$ghuidlog" "$survivor"
  start_fixture
  queue_job "h-$label" acme/app
  local rc=0
  timeout 120 "$@" env SRE_ONCE=1 \
    SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
    SRE_WORKSPACE="$ws" SRE_GITHUB_TOKEN="$github_token" SRE_RUN_TIMEOUT_SECONDS=60 \
    SRE_RUNNER_UID="$owner" SRE_RUNNER_GID="$owner" SRE_RUNNER_HOME="$runner_home" \
    SRE_AGENT_UID="$agent_uid" SRE_AGENT_GID="$agent_uid" SRE_AGENT_HOME="$agent_home" \
    HOME="$runner_home" \
    AWS_ACCESS_KEY_ID=fixture-key AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/fixture \
    STUB_OPENCODE_MODE=fix STUB_OPENCODE_PROBE="$probe" STUB_PROBE_WORKSPACE="$ws" STUB_PROBE_SURVIVOR="$survivor" \
    STUB_OPENCODE_MEMORY=edit STUB_PROBE_GIT="$real_git" \
    FAKE_GIT_UID_LOG="$uidlog" FAKE_GH_UID_LOG="$ghuidlog" \
    node "$runner" > "$out" 2>&1 || rc=$?
  stop_fixture
  local report
  report="$(jq -c 'select(.path | endswith("/h-'"$label"'/report")) | .body' "$work/requests.jsonl" | tail -n 1)"
  survivors+=("$(cat "$survivor" 2>/dev/null || true)")

  if [ "$rc" -eq 0 ] && [ "$(jq -r '.pr_url' <<<"$report")" = "https://github.com/acme/app/pull/7" ]; then echo "ok   $label: the request ends in a pull request"; else echo "FAIL $label: rc=$rc report=$report out=$(tail -n 5 "$out")"; fail=1; return; fi
  if grep -qx "id: $agent_uid:$agent_uid" "$probe"; then echo "ok   $label: the agent runs as its own uid and gid"; else echo "FAIL $label: $(cat "$probe")"; fail=1; fi
  if grep -qx 'groups: ' "$probe"; then echo "ok   $label: its supplementary groups are cleared"; else echo "FAIL $label: $(grep groups "$probe")"; fail=1; fi
  if grep -qx 'cap_eff: 0000000000000000' "$probe"; then echo "ok   $label: it holds no capability"; else echo "FAIL $label: $(grep cap_eff "$probe")"; fail=1; fi
  if grep -qx "home: $agent_home" "$probe"; then echo "ok   $label: its home is its own"; else echo "FAIL $label: $(grep home: "$probe")"; fail=1; fi
  if grep -qx 'runner_environ: denied' "$probe"; then echo "ok   $label: /proc/<runner pid>/environ is not readable by the agent"; else echo "FAIL $label: the runner's environment is readable: $(grep runner_environ "$probe")"; fail=1; fi
  if grep -qx 'memory_list: denied' "$probe" && grep -qx 'memory_write: denied' "$probe"; then echo "ok   $label: the agent can neither read nor write /workspace/memory"; else echo "FAIL $label: $(grep memory "$probe")"; fail=1; fi
  if grep -qx 'other_read: denied' "$probe" && grep -qx 'other_write: denied' "$probe"; then echo "ok   $label: another repository's clone is closed to the agent"; else echo "FAIL $label: $(grep other "$probe")"; fail=1; fi
  if grep -qx 'own_write: allowed' "$probe" && grep -qx 'home_write: allowed' "$probe" && grep -qx 'git_status: ok' "$probe"; then echo "ok   $label: the agent can write its checkout and its home, and git works in the checkout"; else echo "FAIL $label: $(cat "$probe")"; fail=1; fi
  if grep -qx 'aws_env: ' "$probe"; then echo "ok   $label: no AWS variable reaches the agent"; else echo "FAIL $label: $(grep aws_env "$probe" || true)"; fail=1; fi
  if [ -s "$uidlog" ] && ! grep -qvx "$owner" "$uidlog"; then echo "ok   $label: every git call ran as the runner's account ($(wc -l < "$uidlog") calls)"; else echo "FAIL $label: git uids: $(sort -u "$uidlog" | tr '\n' ' ')"; fail=1; fi
  if [ -s "$ghuidlog" ] && ! grep -qvx "$owner" "$ghuidlog"; then echo "ok   $label: gh ran as the runner's account"; else echo "FAIL $label: gh uids: $(sort -u "$ghuidlog" | tr '\n' ' ')"; fail=1; fi
  if [ "$(stat -c %u "$ws/repos/acme/app")" = "$owner" ] && [ "$(stat -c %u "$ws/repos/acme/app/README.md")" = "$owner" ] && [ "$(stat -c %u "$ws/repos/acme/app/.git")" = "$owner" ]; then echo "ok   $label: the checkout is the runner's again once the run ends"; else echo "FAIL $label: $(stat -c '%u %n' "$ws/repos/acme/app" "$ws/repos/acme/app/README.md" "$ws/repos/acme/app/.git")"; fail=1; fi
  if [ "$(stat -c '%a %u' "$ws/memory")" = "700 $owner" ] && [ "$(stat -c '%a %u' "$ws/memory/acme/app/NOTES.md")" = "600 $owner" ]; then echo "ok   $label: memory is 0700 and the files are 0600, all the runner's"; else echo "FAIL $label: $(stat -c '%a %u %n' "$ws/memory" "$ws/memory/acme/app/NOTES.md")"; fail=1; fi
  if [ "$(tail -n 1 "$ws/memory/acme/app/NOTES.md")" = "the pool ceiling is 40 on the primary" ]; then echo "ok   $label: the agent's note reached memory through the copy"; else echo "FAIL $label: $(cat "$ws/memory/acme/app/NOTES.md")"; fail=1; fi
  if [ "$(stat -c '%a' "$ws/repos")" = "711" ] && [ "$(stat -c '%a' "$ws/repos/acme")" = "711" ] && [ "$(stat -c '%a' "$ws")" = "711" ]; then echo "ok   $label: the directories above the checkout can be walked through but not listed"; else echo "FAIL $label: $(stat -c '%a %n' "$ws" "$ws/repos" "$ws/repos/acme")"; fail=1; fi
  if [ "$(cat "$ws/repos/acme/other/secret.txt")" = "another repository, not the agent's to touch" ] && [ ! -e "$ws/repos/acme/other/planted" ]; then echo "ok   $label: the other clone is untouched"; else echo "FAIL $label: the other clone changed"; fail=1; fi
  local pid
  pid="$(cat "$survivor")"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "ok   $label: a process the agent left behind is killed when the run ends"; else echo "FAIL $label: survivor $pid is still running"; fail=1; fi
}

# The root runner carries extra groups, so a child that kept them is caught.
prove root "$runner_uid" setpriv --groups=20001,20002 --
prove caps "$caps_uid" setpriv --reuid="$caps_uid" --regid="$caps_uid" --clear-groups \
  --inh-caps="+setuid,+setgid,+chown,+dac_override,+fowner,+kill" --ambient-caps="+setuid,+setgid,+chown,+dac_override,+fowner,+kill" --

echo "--- a root runner without the account ids refuses to start ---"
start_fixture
rc=0
out="$(timeout 30 env SRE_ONCE=1 SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" SRE_WORKSPACE="$work/refuse" node "$runner" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'SRE_AGENT_UID' <<<"$out"; then echo "ok   it names what is missing"; else echo "FAIL rc=$rc: $out"; fail=1; fi
stop_fixture

exit $fail
