#!/usr/bin/env bash
# The runner and the agent are different accounts, and this test proves it with
# real uids rather than by reading the code: the runner is started once as root
# (the container model) and once as an unprivileged account holding the few
# capabilities it needs (the systemd model), and the stub agent reports what it
# can and cannot reach from where it runs.
#
# Switching uids needs root. The test gets it, in order, from: being root,
# an unprivileged user namespace with a subuid range (no host privilege at all),
# or passwordless sudo. With none of the three it says so and exits 0 on a
# workstation, because a machine that cannot switch uids cannot be tested this
# way; in CI (CI=true or GITHUB_ACTIONS=true) the same situation is a FAILURE,
# because a skipped proof of the account split is a split nobody checked.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  unavailable() {
    if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
      echo "FAIL $1, and this is CI, where the account split has to be proved rather than skipped"
      exit 1
    fi
    echo "SKIP $1"
    exit 0
  }
  if ! command -v setpriv >/dev/null 2>&1; then unavailable "setpriv is not installed, so no uid can be switched"; fi
  if [ ! -r "$(command -v node)" ] || [ ! -x "$(command -v node)" ]; then unavailable "node is not usable"; fi
  if [ "$(id -u)" -eq 0 ]; then
    exec bash "$0" --inner
  elif unshare --user --map-users=auto --map-groups=auto --setuid 0 --setgid 0 setpriv --reuid=10001 --regid=10001 --clear-groups true 2>/dev/null; then
    exec unshare --user --map-users=auto --map-groups=auto --setuid 0 --setgid 0 bash "$0" --inner
  elif sudo -n true 2>/dev/null; then
    exec sudo -n env "PATH=$PATH" bash "$0" --inner
  fi
  unavailable "no way to become root here (not root, no user namespace with a subuid range, no passwordless sudo)"
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
agent_token="$(printf 'sre-agent-agent-tok-%048d' 7)"
model="openrouter/deepseek/deepseek-v4-pro"
remote="$work/remote/app.git"
mkdir -p "$work/bin" "$work/remote" "$work/home" "$work/ctl"
chmod 755 "$work/ctl"
# Where the stubs append the uid they run as. The runner starts git and gh with
# a minimal environment, so the path is read from a file, never a variable.
mkdir -p "$work/markers"
chmod 777 "$work/markers"
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
# The agent's own git (it works in a repository of its own) is judged by its uid
# being the agent's; this log is the runner's calls.
if [ "\$(id -u)" != "$agent_uid" ]; then id -u >> "\$(cat "$work/ctl/git_uid_log")"; fi
args=()
for a in "\$@"; do
  case "\$a" in
    https://*@github.com/*) args+=("$remote") ;;
    *) args+=("\$a") ;;
  esac
done
exec "$real_git" "\${args[@]}"
EOF
cat > "$work/bin/gh" <<EOF
#!/usr/bin/env bash
id -u >> "\$(cat "$work/ctl/gh_uid_log")"
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
  local prefix=("$@")
  local extra_runner_env=()
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
  # The agent's home is left to the runner: it is created root-owned here, and
  # the runner has to make it the agent's and close it to everyone else.
  : > "$probe"; : > "$uidlog"; : > "$ghuidlog"; : > "$survivor"
  chmod 666 "$probe" "$uidlog" "$ghuidlog" "$survivor"
  printf '%s' "$uidlog" > "$work/ctl/git_uid_log"
  printf '%s' "$ghuidlog" > "$work/ctl/gh_uid_log"
  rm -rf "$work/markers"; mkdir -p "$work/markers"; chmod 777 "$work/markers"
  # A bare repository the agent can clone by path, owned by the agent: the test
  # of "clone" needs no network, and git refuses a repository of another uid.
  local clone_src="$work/$label-clone-src.git"
  rm -rf "$clone_src"
  "$real_git" init -q --bare -b main "$clone_src"
  chown -R "$agent_uid:$agent_uid" "$clone_src"
  local rc=0
  invoke_runner() {
    local id="$1" probe_file="$2" survivor_file="$3"
    start_fixture
    queue_job "$id" acme/app
    rc=0
    timeout 120 "${prefix[@]}" env SRE_ONCE=1 \
      SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
      SRE_WORKSPACE="$ws" SRE_GITHUB_TOKEN="$github_token" SRE_RUN_TIMEOUT_SECONDS=60 \
      SRE_RUNNER_UID="$owner" SRE_RUNNER_GID="$owner" SRE_RUNNER_HOME="$runner_home" \
      SRE_AGENT_UID="$agent_uid" SRE_AGENT_GID="$agent_uid" SRE_AGENT_HOME="$agent_home" \
      HOME="$runner_home" \
      AWS_ACCESS_KEY_ID=fixture-key AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/fixture \
      STUB_OPENCODE_MODE=fix STUB_OPENCODE_PROBE="$probe_file" STUB_PROBE_WORKSPACE="$ws" STUB_PROBE_SURVIVOR="$survivor_file" \
      STUB_OPENCODE_MEMORY=edit STUB_PROBE_GIT="$real_git" STUB_CLONE_SOURCE="$clone_src" STUB_EXPECT_GH_TOKEN="$github_token" STUB_RUNNER_TOKEN="$github_token" \
      "${extra_runner_env[@]}" \
      STUB_PROBE_GITDIR="$ws/gitdirs/acme/app" STUB_PLANT_MARKER="$work/markers/tree-config" \
      node "$runner" > "$out" 2>&1 || rc=$?
    stop_fixture
  }
  invoke_runner "h-$label" "$probe" "$survivor"
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
  if grep -qx 'own_write: allowed' "$probe" && grep -qx 'home_write: allowed' "$probe"; then echo "ok   $label: the agent can write its checkout and its home"; else echo "FAIL $label: $(cat "$probe")"; fail=1; fi
  if grep -qx 'tree_git: present' "$probe" && grep -qx 'git_in_tree: works' "$probe" && grep -qx 'git_history: ok' "$probe" && grep -qx "git_repo_owner: $agent_uid" "$probe"; then echo "ok   $label: the agent works in a real repository of its own, with history, that it owns"; else echo "FAIL $label: $(grep -E 'tree_git|git_in_tree|git_history|git_repo_owner' "$probe")"; fail=1; fi
  if grep -qx 'git_alternates: absent' "$probe" && grep -qx 'git_origin: https://github.com/acme/app.git' "$probe"; then echo "ok   $label: its repository shares no object store with the runner's, and origin is the github.com URL with no token in it"; else echo "FAIL $label: $(grep -E 'git_alternates|git_origin' "$probe")"; fail=1; fi
  if grep -qx 'gitdir_list: denied' "$probe" && grep -qx 'gitdir_write: denied' "$probe"; then echo "ok   $label: the agent can neither read the git directory nor write commondir, alternates, grafts, a replace ref, config.worktree, attributes, config or a hook into it"; else echo "FAIL $label: $(grep gitdir "$probe")"; fail=1; fi
  if [ -z "$(ls -A "$work/markers")" ]; then echo "ok   $label: the filter and fsmonitor the agent planted in its tree never ran"; else echo "FAIL $label: these ran: $(find "$work/markers" -mindepth 1 -printf '%f ')"; fail=1; fi
  if [ "$(stat -c '%a %u' "$ws/gitdirs/acme/app")" = "700 $owner" ] && [ "$(stat -c '%a %u' "$ws/gitdirs")" = "700 $owner" ]; then echo "ok   $label: the git directory is the runner's, mode 0700"; else echo "FAIL $label: $(stat -c '%a %u %n' "$ws/gitdirs" "$ws/gitdirs/acme/app")"; fail=1; fi
  if grep -qx 'aws_env: ' "$probe"; then echo "ok   $label: no AWS variable reaches the agent"; else echo "FAIL $label: $(grep aws_env "$probe" || true)"; fail=1; fi
  if [ -s "$uidlog" ] && ! grep -qvx "$owner" "$uidlog"; then echo "ok   $label: every git call ran as the runner's account ($(wc -l < "$uidlog") calls)"; else echo "FAIL $label: git uids: $(sort -u "$uidlog" | tr '\n' ' ')"; fail=1; fi
  if [ -s "$ghuidlog" ] && ! grep -qvx "$owner" "$ghuidlog"; then echo "ok   $label: gh ran as the runner's account"; else echo "FAIL $label: gh uids: $(sort -u "$ghuidlog" | tr '\n' ' ')"; fail=1; fi
  if [ "$(stat -c %u "$ws/repos/acme/app")" = "$owner" ] && [ "$(stat -c %u "$ws/repos/acme/app/README.md")" = "$owner" ] && [ ! -e "$ws/repos/acme/app/.git" ]; then echo "ok   $label: the checkout is the runner's again once the run ends, and the .git the agent planted is gone"; else echo "FAIL $label: $(stat -c '%u %n' "$ws/repos/acme/app" "$ws/repos/acme/app/README.md"; ls -a "$ws/repos/acme/app")"; fail=1; fi
  if [ "$(stat -c '%a %u' "$ws/memory")" = "700 $owner" ] && [ "$(stat -c '%a %u' "$ws/memory/acme/app/NOTES.md")" = "600 $owner" ]; then echo "ok   $label: memory is 0700 and the files are 0600, all the runner's"; else echo "FAIL $label: $(stat -c '%a %u %n' "$ws/memory" "$ws/memory/acme/app/NOTES.md")"; fail=1; fi
  if [ "$(tail -n 1 "$ws/memory/acme/app/NOTES.md")" = "the pool ceiling is 40 on the primary" ]; then echo "ok   $label: the agent's note reached memory through the copy"; else echo "FAIL $label: $(cat "$ws/memory/acme/app/NOTES.md")"; fail=1; fi
  if [ "$(stat -c '%a' "$ws/repos")" = "711" ] && [ "$(stat -c '%a' "$ws/repos/acme")" = "711" ] && [ "$(stat -c '%a' "$ws")" = "711" ]; then echo "ok   $label: the directories above the checkout can be walked through but not listed"; else echo "FAIL $label: $(stat -c '%a %n' "$ws" "$ws/repos" "$ws/repos/acme")"; fail=1; fi
  if [ "$(cat "$ws/repos/acme/other/secret.txt")" = "another repository, not the agent's to touch" ] && [ ! -e "$ws/repos/acme/other/planted" ]; then echo "ok   $label: the other clone is untouched"; else echo "FAIL $label: the other clone changed"; fail=1; fi
  local pid
  pid="$(cat "$survivor")"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "ok   $label: a process the agent left behind is killed when the run ends"; else echo "FAIL $label: survivor $pid is still running"; fail=1; fi

  echo "--- $label: the agent can do what a CI job does ---"
  if [ "$(stat -c '%a %u' "$agent_home")" = "700 $agent_uid" ]; then echo "ok   $label: the agent's home is the agent's, mode 0700, though the test made it root-owned"; else echo "FAIL $label: $(stat -c '%a %u %n' "$agent_home")"; fail=1; fi
  if [ -f "$agent_home/.gitconfig" ] && [ "$(stat -c %u "$agent_home/.gitconfig")" = "$agent_uid" ]; then echo "ok   $label: the home holds a git configuration of the agent's"; else echo "FAIL $label: no .gitconfig in $agent_home"; fail=1; fi
  if grep -qx "path_first: $agent_home/.local/bin" "$probe" && grep -qx 'path_has_mise_shims: yes' "$probe"; then echo "ok   $label: user-space installs and mise shims are on its PATH"; else echo "FAIL $label: $(grep path_ "$probe")"; fail=1; fi
  if grep -qx "npm_prefix: $agent_home/.npm-global" "$probe" && grep -qx "mise_data_dir: $agent_home/.local/share/mise" "$probe"; then echo "ok   $label: npm's global prefix and mise's data directory are under its home"; else echo "FAIL $label: $(grep -E 'npm_prefix|mise_data' "$probe")"; fail=1; fi
  if grep -qx 'token_env: ' "$probe"; then echo "ok   $label: it holds no poll key and none of the runner's account variables"; else echo "FAIL $label: $(grep token_env "$probe")"; fail=1; fi
  if grep -qx 'gh_token: matches' "$probe" && grep -qx 'credential_helper: ok' "$probe"; then echo "ok   $label: it does hold the repository token, as GH_TOKEN, and its git credential helper answers github.com with it"; else echo "FAIL $label: $(grep -E 'gh_token|credential_helper' "$probe")"; fail=1; fi
  if grep -qx 'pip_break: 1' "$probe"; then echo "ok   $label: pip --user works on the image python, which marks itself externally managed"; else echo "FAIL $label: $(grep pip_break "$probe")"; fail=1; fi
  if ! grep -qF "$github_token" "$work/$label.out" "$work/requests.jsonl"; then echo "ok   $label: the token is in no log line and no report, though the agent holds it"; else echo "FAIL $label: the token was logged or reported"; fail=1; fi
  if grep -qx 'clone_local: ok' "$probe" && grep -qx 'commit_local: ok' "$probe" && ! grep -qx 'git_user: none' "$probe"; then echo "ok   $label: it clones a repository by path and commits in the clone with the identity in its home"; else echo "FAIL $label: $(grep -E 'clone_local|commit_local|git_user' "$probe")"; fail=1; fi
  if grep -qx 'tool: installed' "$probe"; then echo "ok   $label: the first run installs a tool into its home"; else echo "FAIL $label: $(grep tool: "$probe")"; fail=1; fi

  local probe2="$work/$label.probe2" survivor2="$work/$label.survivor2"
  : > "$probe2"; : > "$survivor2"; chmod 666 "$probe2" "$survivor2"
  rm -rf "$work/markers"; mkdir -p "$work/markers"; chmod 777 "$work/markers"
  invoke_runner "h-$label-2" "$probe2" "$survivor2"
  survivors+=("$(cat "$survivor2" 2>/dev/null || true)")
  local report2
  report2="$(jq -c 'select(.path | endswith("/h-'"$label"'-2/report")) | .body' "$work/requests.jsonl" | tail -n 1)"
  if [ "$rc" -eq 0 ] && [ "$(jq -r '.pr_url' <<<"$report2")" = "https://github.com/acme/app/pull/7" ]; then echo "ok   $label: a second request ends in a pull request too"; else echo "FAIL $label: second run rc=$rc report=$report2 out=$(tail -n 5 "$out")"; fail=1; return; fi
  if grep -qx 'tool: found fixture-tool-ok' "$probe2"; then echo "ok   $label: the tool installed by the first run is on its PATH in the second, and runs"; else echo "FAIL $label: $(grep tool: "$probe2")"; fail=1; fi
  if grep -qx 'clone_local: ok' "$probe2"; then echo "ok   $label: it clones again in the second run"; else echo "FAIL $label: $(grep clone "$probe2")"; fail=1; fi
  if grep -qx 'probe_runner_token_visible: yes' "$probe2" && grep -qx 'helper_hands_out_runner_token: yes' "$probe2"; then echo "ok   $label: without SRE_AGENT_GITHUB_TOKEN the agent holds the runner token, in GH_TOKEN and through its credential helper"; else echo "FAIL $label: $(grep -E 'runner_token' "$probe2")"; fail=1; fi

  echo "--- $label: with SRE_AGENT_GITHUB_TOKEN the agent holds a token of its own ---"
  local probe3="$work/$label.probe3" survivor3="$work/$label.survivor3"
  : > "$probe3"; : > "$survivor3"; chmod 666 "$probe3" "$survivor3"
  rm -rf "$work/markers"; mkdir -p "$work/markers"; chmod 777 "$work/markers"
  extra_runner_env=(SRE_AGENT_GITHUB_TOKEN="$agent_token" STUB_EXPECT_GH_TOKEN="$agent_token")
  invoke_runner "h-$label-3" "$probe3" "$survivor3"
  survivors+=("$(cat "$survivor3" 2>/dev/null || true)")
  local report3
  report3="$(jq -c 'select(.path | endswith("/h-'"$label"'-3/report")) | .body' "$work/requests.jsonl" | tail -n 1)"
  if [ "$rc" -eq 0 ] && [ "$(jq -r '.pr_url' <<<"$report3")" = "https://github.com/acme/app/pull/7" ]; then echo "ok   $label: the pull request still lands, pushed by the runner with its own token"; else echo "FAIL $label: third run rc=$rc report=$report3 out=$(tail -n 5 "$out")"; fail=1; return; fi
  if grep -qx 'gh_token: matches' "$probe3" && grep -qx 'credential_helper: ok' "$probe3"; then echo "ok   $label: GH_TOKEN and the credential helper both carry the agent token"; else echo "FAIL $label: $(grep -E 'gh_token|credential_helper' "$probe3")"; fail=1; fi
  if grep -qx 'probe_runner_token_visible: no' "$probe3" && grep -qx 'helper_hands_out_runner_token: no' "$probe3"; then echo "ok   $label: the runner token is nowhere in its environment and the helper never hands it out"; else echo "FAIL $label: $(grep -E 'runner_token' "$probe3")"; fail=1; fi
  if grep -qx 'token_env: ' "$probe3"; then echo "ok   $label: the variable that names the agent token is not in its environment"; else echo "FAIL $label: $(grep token_env "$probe3")"; fail=1; fi
  if ! grep -qF -e "$github_token" -e "$agent_token" "$work/$label.out" "$work/requests.jsonl"; then echo "ok   $label: neither token is in a log line or a report"; else echo "FAIL $label: a token was logged or reported"; fail=1; fi
  extra_runner_env=()
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
