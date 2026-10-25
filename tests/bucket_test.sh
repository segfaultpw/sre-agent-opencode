#!/usr/bin/env bash
# The runner's mirror of its memory to the operator's own S3 bucket, and the
# restore of that memory onto an empty volume (runner/bucket.js).
#
# The real runner runs against the fixture platform with the AWS CLI replaced
# by tests/fixture/stub_aws.sh, which records every argument it receives and
# plays the bucket from a directory the case builds. The workspace is named
# with spaces and shell metacharacters on purpose: a call that went through a
# shell would run the command in the name and leave a file starting PWNED_.
# The assertions are on the calls the stub received and on what is on the
# volume afterwards, not on what the runner said about itself.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/.."
runner="$pkg/runner/runner.js"
entrypoint="$pkg/runner/entrypoint.sh"
fail=0

if command -v node >/dev/null 2>&1; then echo "ok   node is on PATH"; else echo "FAIL node is not on PATH"; exit 1; fi
if command -v jq >/dev/null 2>&1; then echo "ok   jq is on PATH"; else echo "FAIL jq is not on PATH"; exit 1; fi

work="$(mktemp -d)"
fixture_pid=""
fixture_pids=()
# shellcheck disable=SC2329 # the EXIT trap below runs it
cleanup() {
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  for pid in "${fixture_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
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

check_jq() {
  if jq -e "$2" <<<"$3" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1 (input: $3)"; fail=1; fi
}
check_jqf() {
  if jq -e "$2" "$3" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1 (file: $(cat "$3" 2>/dev/null))"; fail=1; fi
}

# The variables a developer's shell may carry would change what the runner
# hands the AWS CLI, which is the thing these cases pin down.
for name in $(env | cut -d= -f1 | grep -E '^(AWS_|ECS_CONTAINER|SRE_)' || true); do unset "$name"; done

api_key="$(printf 'sre-agent-poll-%048d' 1)"
handoff_token="$(printf 'sre-agent-handoff-%048d' 2)"
github_token="$(printf 'sre-agent-github-%048d' 3)"
aws_key_id="AKIAFIXTUREKEY"
aws_secret="$(printf 'fixture-aws-secret-%040d' 6)"
model="openrouter/deepseek/deepseek-v4-pro"
us=$'\037'

ctl="$work/ctl"
mkdir -p "$work/bin" "$ctl" "$work/outside"
printf 'do not touch\n' > "$work/outside/precious"
install -m 755 "$here/fixture/stub_aws.sh" "$work/bin/aws"
install -m 755 "$here/fixture/stub_opencode.sh" "$work/bin/opencode"
export PATH="$work/bin:$PATH"

# A name a shell would act on, in every way it can.
workspace="$work/ws \$(touch PWNED_2) \`touch PWNED_3\`; touch PWNED_1 'q' & *"
mkdir -p "$workspace"

brief_file="$work/brief.md"
queue_file="$work/queue.json"
opencode_log="$work/opencode.log"
brief_seen="$work/brief_seen.md"
printf '# Fix request\n\nThe checkout service refuses connections under load.\n' > "$brief_file"

export STUB_OPENCODE_LOG="$opencode_log" STUB_OPENCODE_BRIEF_OUT="$brief_seen"
export FIXTURE_PORT_FILE="$work/port" FIXTURE_API_KEY="$api_key"
export FIXTURE_HANDOFF_TOKEN="$handoff_token" FIXTURE_BRIEF_FILE="$brief_file"
export FIXTURE_QUEUE_FILE="$queue_file" FIXTURE_QUEUE_STATUSES=200
export STUB_OPENCODE_MODE=diagnose
export AWS_ACCESS_KEY_ID="$aws_key_id" AWS_SECRET_ACCESS_KEY="$aws_secret"

fixture_log=""
server_url="http://127.0.0.1:9"
rc=0
out=""
report=""
BUCKET_V=""
PREFIX_V=""

start_fixture() {
  stop_fixture
  fixture_log="$work/$1.requests.jsonl"
  : > "$fixture_log"
  rm -f "$work/port"
  FIXTURE_LOG="$fixture_log" node "$here/fixture/queue_server.js" &
  fixture_pid=$!
  fixture_pids+=("$fixture_pid")
  local waited=0
  while [ ! -s "$work/port" ] && [ "$waited" -lt 200 ]; do
    sleep 0.05
    waited=$((waited + 1))
  done
  if [ ! -s "$work/port" ]; then echo "FAIL the fixture platform did not start"; exit 1; fi
  server_url="http://127.0.0.1:$(cat "$work/port")"
  printf '%s' "$fixture_log" > "$ctl/fixture_log_path"
}

stop_fixture() {
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
    fixture_pid=""
  fi
}

queue_one() {
  jq -n --arg id "$1" --arg base "$server_url" --arg token "$handoff_token" \
    '[{handoff_id: $id,
       subject_id: "11111111-2222-3333-4444-555555555555",
       repo_full_name: null,
       brief_url: ($base + "/api/handoffs/" + $id + "/brief"),
       report_url: ($base + "/api/handoffs/" + $id + "/report"),
       token: $token}]' > "$queue_file"
}

# A test job as the platform queues it (see tests/runner_test.sh).
queue_test_job() {
  jq -n --arg id "$1" --arg repo "$2" --arg base "$server_url" --arg token "$handoff_token" \
    '[{handoff_id: $id,
       subject_id: "77777777-2222-3333-4444-555555555555",
       repo_full_name: null,
       test: true,
       test_repo_full_name: (if $repo == "" then null else $repo end),
       brief_url: ($base + "/api/handoffs/" + $id + "/brief"),
       report_url: ($base + "/api/handoffs/" + $id + "/report"),
       token: $token}]' > "$queue_file"
}

reset_aws() {
  rm -rf "$ctl/uploaded" "$ctl/bucket_tree" "$ctl/aws_fail" "$ctl/aws_fail_on" "$ctl/aws_partial_fail" \
    "$ctl/aws_fail_first" "$ctl/aws_kill_runner" "$ctl/aws_exit2" "$ctl/aws_hang" "$ctl/aws_sleep"
  : > "$ctl/aws_calls.log"
  : > "$ctl/aws_seen.log"
  : > "$ctl/aws_env.log"
}

fresh_workspace() {
  rm -rf "$workspace"
  mkdir -p "$workspace"
}

# The marker a finished first sync leaves: it names the bucket and prefix the
# volume was mirrored to, because a volume mirrored to one bucket has not been
# mirrored to another.
write_sync_marker() {
  printf '{"at":"2026-01-01T00:00:00.000Z","target":"s3://%s/%s"}\n' "$1" "$2" > "$workspace/.memory-first-sync"
}

calls() { grep -c '' "$ctl/aws_calls.log" || true; }
call_line() { sed -n "${1}p" "$ctl/aws_calls.log"; }
seen_at() { sed -n "${1}p" "$ctl/aws_seen.log"; }
argline() {
  local joined="" arg
  for arg in "$@"; do joined+="${arg}${us}"; done
  printf '%s' "$joined"
}

# The restore downloads into a staging directory beside memory/, named for the
# runner's pid, so the call is matched by its shape.
restore_call() {
  local line="$1" source="$2" head rest
  head="s3${us}cp${us}--recursive${us}${source}${us}${workspace}/.memory-restore-"
  [[ "$line" == "$head"* ]] || return 1
  rest="${line#"$head"}"
  [[ "$rest" =~ ^[0-9]+/${us}--only-show-errors${us}$ ]]
}
no_staging() { test -z "$(find "$workspace" -maxdepth 1 -name '.memory-restore-[0-9]*' -print -quit 2>/dev/null)"; }

env_args() {
  env_extra=()
  if [ -n "$BUCKET_V" ]; then env_extra+=("SRE_MEMORY_BUCKET=$BUCKET_V"); fi
  if [ -n "$PREFIX_V" ]; then env_extra+=("SRE_MEMORY_PREFIX=$PREFIX_V"); fi
}

run_runner() {
  : > "$opencode_log"
  out="$work/$1.out"
  rc=0
  env_args
  (cd "$work" && timeout "${run_timeout:-120}" env SRE_ONCE=1 \
    SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
    SRE_WORKSPACE="$workspace" SRE_GITHUB_TOKEN="$github_token" SRE_RUN_TIMEOUT_SECONDS=60 \
    "${env_extra[@]}" node "$runner") > "$out" 2>&1 || rc=$?
  report="$(jq -c 'select(.path | endswith("/report")) | .body' "$fixture_log" 2>/dev/null | tail -n 1 || true)"
}

# What the runner does around a job, called from a script, so the result it
# hands back can be read: the restore at start, then the retry and the job.
# DRIVER_DEADLINE_MS shortens the mirror's overall limit for the cases that
# prove it.
run_driver() {
  : > "$opencode_log"
  out="$work/$1.out"
  rc=0
  env_args
  jq -c '.[0]' "$queue_file" > "$work/job.json"
  rm -f "$work/$1.result.json"
  (cd "$work" && timeout 120 env \
    SRE_SERVER_URL="$server_url" SRE_API_KEY="$api_key" SRE_MODEL="$model" \
    SRE_WORKSPACE="$workspace" SRE_GITHUB_TOKEN="$github_token" SRE_RUN_TIMEOUT_SECONDS=60 \
    DRIVER_JOB="$work/job.json" DRIVER_OUT="$work/$1.result.json" DRIVER_DEADLINE_MS="${driver_deadline_ms:-}" \
    "${env_extra[@]}" node -e '
      const fs = require("node:fs");
      const runner = require(process.argv[1]);
      const config = runner.loadConfig();
      if (process.env.DRIVER_DEADLINE_MS) config.memoryBucket.deadlineMs = Number(process.env.DRIVER_DEADLINE_MS);
      const job = JSON.parse(fs.readFileSync(process.env.DRIVER_JOB, "utf8"));
      runner.startMemory(config)
        .then(() => runner.serveJob(config, job))
        .then((result) => {
          fs.writeFileSync(process.env.DRIVER_OUT, JSON.stringify({
            changes: result.memoryChanges,
            mirror: result.mirror === undefined ? "missing" : result.mirror,
            outcome: result.outcome,
          }));
        });
    ' "$runner") > "$out" 2>&1 || rc=$?
  report="$(jq -c 'select(.path | endswith("/report")) | .body' "$fixture_log" 2>/dev/null | tail -n 1 || true)"
}

seed_estate() {
  mkdir -p "$workspace/memory/_estate/scripts"
  printf '# Estate\n\nThe checkout service pages the on-call nightly.\n' > "$workspace/memory/_estate/NOTES.md"
  printf '# an old estate helper\n' > "$workspace/memory/_estate/scripts/old.sh"
}

pwned() { find "$work" "$PWD" -name 'PWNED_*' -print -quit 2>/dev/null; }

echo "--- 1. a bucket or a prefix that cannot be used refuses to start, naming the variable ---"
reset_aws
run_timeout=20
long_bucket="$(printf 'a%.0s' $(seq 1 64))"
for bad in 'Bad_Bucket' "$long_bucket" 's3://bucket' 'a;touch x'; do
  BUCKET_V="$bad"
  PREFIX_V=""
  run_runner bad_bucket
  if [ "$rc" -ne 0 ] && grep -qF 'SRE_MEMORY_BUCKET' "$out"; then echo "ok   bucket '${bad:0:20}' refuses to start and names SRE_MEMORY_BUCKET"; else echo "FAIL bucket '${bad:0:20}' rc=$rc: $(cat "$out")"; fail=1; fi
done
# shellcheck disable=SC2016 # the text of a command substitution is the value under test
for bad in '/abs/' 'a/../b/' 'a;b/' '$(x)/'; do
  BUCKET_V="acme-sre-memory"
  PREFIX_V="$bad"
  run_runner bad_prefix
  if [ "$rc" -ne 0 ] && grep -qF 'SRE_MEMORY_PREFIX' "$out"; then echo "ok   prefix '$bad' refuses to start and names SRE_MEMORY_PREFIX"; else echo "FAIL prefix '$bad' rc=$rc: $(cat "$out")"; fail=1; fi
done
check "a refused configuration calls aws never" test "$(calls)" -eq 0
BUCKET_V=""
PREFIX_V=""
unset run_timeout

echo "--- 2. the module validates and normalises, and a path no shell is involved in ---"
cat > "$work/unit.js" <<'EOF'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bucket = require(path.join(process.argv[2], 'runner', 'bucket.js'));
const workspace = process.argv[3];
const log = process.argv[4];
const emit = (value) => console.log(JSON.stringify(value));
const count = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
const run = async (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', timedOut: false };
};
const settings = (extra = {}) => ({ bucket: 'acme-sre-memory', prefix: 'fleet/', workspace, run, log: () => {}, ...extra });

(async () => {
  const exact63 = 'a'.repeat(63);
  const envs = [
    {},
    { SRE_MEMORY_BUCKET: '' },
    { SRE_MEMORY_BUCKET: 'acme-sre-memory' },
    { SRE_MEMORY_BUCKET: exact63 },
    { SRE_MEMORY_BUCKET: 'acme.memory.eu', SRE_MEMORY_PREFIX: 'team-a/memory' },
    { SRE_MEMORY_BUCKET: 'acme-sre-memory', SRE_MEMORY_PREFIX: 'memory//' },
    { SRE_MEMORY_BUCKET: 'acme-sre-memory', SRE_MEMORY_PREFIX: '' },
    { SRE_MEMORY_PREFIX: '../ignored/' },
  ];
  for (const env of envs) {
    try {
      emit({ kind: 'env', env, result: bucket.fromEnv(env) });
    } catch (error) {
      emit({ kind: 'env', env, error: error.message });
    }
  }

  const badBuckets = ['Bad_Bucket', 'ab', 'a'.repeat(64), 'a..b', '192.168.1.1', 's3://bucket', 'arn:aws:s3:::bucket', 'has space', 'a;touch x', '-lead', 'trail-', 'xn--bucket', 'bucket-s3alias', 'amzn-s3-demo-x', 'UPPER', 'a$(x)b'];
  for (const name of badBuckets) {
    try {
      emit({ kind: 'bad-bucket', input: name, result: bucket.fromEnv({ SRE_MEMORY_BUCKET: name }) });
    } catch (error) {
      emit({ kind: 'bad-bucket', input: name, error: error.message });
    }
  }
  const badPrefixes = ['/abs/', '../up/', 'a/../b/', 'a//b/', 'a b/', 'a;b/', './', '.', 'a/./b', '$(x)/', '/', '..', 'a\\b/', 'x'.repeat(600)];
  for (const prefix of badPrefixes) {
    try {
      emit({ kind: 'bad-prefix', input: prefix, result: bucket.fromEnv({ SRE_MEMORY_BUCKET: 'acme-sre-memory', SRE_MEMORY_PREFIX: prefix }) });
    } catch (error) {
      emit({ kind: 'bad-prefix', input: prefix, error: error.message });
    }
  }

  const before = count();
  emit({ kind: 'nobucket-restore', result: await bucket.restore(settings({ bucket: '' })), calls: count() - before });
  emit({ kind: 'nobucket-mirror', result: await bucket.mirror(settings({ bucket: '' }), [{ path: '_estate/NOTES.md', change: 'modified', bytes: 1 }]), calls: count() - before });
  emit({ kind: 'nochanges', result: await bucket.mirror(settings(), []), calls: count() - before });

  const hostile = [
    'acme/api/scripts/a b',
    'acme/api/scripts/x;touch PWNED_U',
    'acme/api/scripts/$(touch PWNED_V)',
    'acme/api/scripts/`touch PWNED_W`',
    '../x/NOTES.md',
    '/abs/NOTES.md',
    'acme/../../x/NOTES.md',
    'acme/api/extra.txt',
    'acme/api/scripts/sub/x',
    'acme/NOTES.md',
    '_estate/extra.txt',
    '',
  ];
  for (const bad of hostile) {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: bad, change: 'added', bytes: 1 }]);
    emit({ kind: 'hostile', path: bad, result, calls: count() - start });
  }

  for (const leftover of ['acme/api.sre-agent-new-5/NOTES.md', '_estate.sre-agent-old-5/scripts/x']) {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: leftover, change: 'added', bytes: 1 }]);
    emit({ kind: 'leftover', path: leftover, result, calls: count() - start });
  }

  {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: 'acme/api/NOTES.md', change: 'modified', bytes: 1 }]);
    emit({ kind: 'symlinked-file', result, calls: count() - start });
  }
  {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: 'linked/api/NOTES.md', change: 'modified', bytes: 1 }]);
    emit({ kind: 'linked-owner', result, calls: count() - start });
  }
  {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: 'acme/api/scripts/gone.sh', change: 'added', bytes: 1 }]);
    emit({ kind: 'missing-file', result, calls: count() - start });
  }
  for (const owner of ['repos', 'gitdirs', 'agent-home', 'scratch', 'memory']) {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: `${owner}/x/NOTES.md`, change: 'added', bytes: 1 }]);
    emit({ kind: 'owner-named-like-a-workspace-directory', owner, result, calls: count() - start });
  }
  {
    const start = count();
    const result = await bucket.mirror(settings(), [{ path: 'acme/api/scripts/ok.sh', change: 'added', bytes: 1 }]);
    emit({ kind: 'space-name', result, calls: count() - start });
  }
  {
    const start = count();
    const result = await bucket.mirror(settings(), [
      { path: 'acme/api/NOTES.md', change: 'removed', bytes: 3 },
      { path: 'acme/api/scripts/ok.sh', change: 'added', bytes: 3 },
    ]);
    emit({ kind: 'valid-nested', result, calls: count() - start });
  }
  emit({ kind: 'journal', left: fs.existsSync(path.join(workspace, '.memory-mirror-pending')) });

  if (process.getuid() !== 0) {
    const readOnly = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'retry-'));
    fs.writeFileSync(path.join(readOnly, '.memory-restore-pending'), '{}\n');
    fs.chmodSync(readOnly, 0o500);
    const config = settings({ workspace: readOnly, state: {} });
    const start = count();
    const first = await bucket.retryRestore(config);
    const second = await bucket.retryRestore(config);
    fs.chmodSync(readOnly, 0o700);
    fs.rmSync(readOnly, { recursive: true, force: true });
    emit({ kind: 'retry-throws', first, second, failures: config.state.failures, calls: count() - start });
  }
})();
EOF
reset_aws
fresh_workspace
mkdir -p "$workspace/memory/acme/api/scripts"
printf 'real file\n' > "$work/real_notes"
ln -s "$work/real_notes" "$workspace/memory/acme/api/NOTES.md"
printf '#!/bin/sh\n' > "$workspace/memory/acme/api/scripts/ok.sh"
mkdir -p "$work/linkedtarget/api"
printf 'a real file behind a linked owner directory\n' > "$work/linkedtarget/api/NOTES.md"
ln -s "$work/linkedtarget" "$workspace/memory/linked"
for owner in repos gitdirs agent-home scratch memory; do
  mkdir -p "$workspace/memory/$owner/x"
  printf 'an owner called %s\n' "$owner" > "$workspace/memory/$owner/x/NOTES.md"
done
(cd "$work" && node --max-old-space-size=256 "$work/unit.js" "$pkg" "$workspace" "$ctl/aws_calls.log") > "$work/unit.out" 2>&1 || { echo "FAIL the unit driver failed: $(cat "$work/unit.out")"; fail=1; }
unit() { jq -c --arg kind "$1" 'select(.kind == $kind)' "$work/unit.out"; }
env_case() { jq -c --argjson env "$1" 'select(.kind == "env" and .env == $env)' "$work/unit.out"; }

check_jq "no variables means no bucket" '.result.bucket == ""' "$(env_case '{}')"
check_jq "an empty SRE_MEMORY_BUCKET means no bucket" '.result.bucket == ""' "$(env_case '{"SRE_MEMORY_BUCKET":""}')"
check_jq "the prefix defaults to memory/" '.result == {bucket: "acme-sre-memory", prefix: "memory/"}' "$(env_case '{"SRE_MEMORY_BUCKET":"acme-sre-memory"}')"
check_jq "a 63 character bucket is accepted" '.result.bucket | length == 63' "$(env_case "{\"SRE_MEMORY_BUCKET\":\"$(printf 'a%.0s' $(seq 1 63))\"}")"
check_jq "a prefix without a trailing slash gets one, and a dotted bucket is accepted" '.result == {bucket: "acme.memory.eu", prefix: "team-a/memory/"}' "$(env_case '{"SRE_MEMORY_BUCKET":"acme.memory.eu","SRE_MEMORY_PREFIX":"team-a/memory"}')"
check_jq "repeated trailing slashes are folded into one" '.result.prefix == "memory/"' "$(env_case '{"SRE_MEMORY_BUCKET":"acme-sre-memory","SRE_MEMORY_PREFIX":"memory//"}')"
check_jq "an empty prefix takes the default" '.result.prefix == "memory/"' "$(env_case '{"SRE_MEMORY_BUCKET":"acme-sre-memory","SRE_MEMORY_PREFIX":""}')"
check_jq "a prefix without a bucket is not validated, because nothing will use it" '.result.bucket == ""' "$(env_case '{"SRE_MEMORY_PREFIX":"../ignored/"}')"

check "every bucket that is not a valid S3 bucket name is refused, naming SRE_MEMORY_BUCKET" test "$(unit bad-bucket | jq -s '[.[] | select((.error // "") | contains("SRE_MEMORY_BUCKET"))] | length')" -eq "$(unit bad-bucket | grep -c '')"
check "every prefix that is not a relative key prefix is refused, naming SRE_MEMORY_PREFIX" test "$(unit bad-prefix | jq -s '[.[] | select((.error // "") | contains("SRE_MEMORY_PREFIX"))] | length')" -eq "$(unit bad-prefix | grep -c '')"
check_jq "with no bucket restore skips and calls nothing" '.result.skipped != null and .calls == 0' "$(unit nobucket-restore)"
check_jq "with no bucket a mirror calls nothing and is ok" '.result.ok == true and .calls == 0' "$(unit nobucket-mirror)"
check_jq "no changes means no call" '.result.ok == true and .calls == 0' "$(unit nochanges)"
hostile_total="$(unit hostile | grep -c '' || true)"
refused="$(unit hostile | jq -s '[.[] | select(.result.ok == false and .calls == 0 and (.result.error | type == "string"))] | length')"
check "every one of the $hostile_total names that are not a memory file is refused and calls nothing" test "$refused" -eq "$hostile_total"
check "a leftover directory of a stopped save is not mirrored" test "$(unit leftover | jq -s '[.[] | select(.result.ok == true and .calls == 0)] | length')" -eq 2
check_jq "a memory file that is a symlink is not uploaded" '.result.ok == false and .calls == 0' "$(unit symlinked-file)"
check_jq "a real file reached through a linked owner directory is not uploaded" '.result.ok == false and .calls == 0 and (.result.error | contains("outside"))' "$(unit linked-owner)"
check "an owner named like a workspace directory is an ordinary owner under memory/, mirrored" test "$(unit owner-named-like-a-workspace-directory | jq -s '[.[] | select(.result.ok == true and .calls == 1)] | length')" -eq 5
check_jq "a refused or finished mirror leaves no journal behind" '.left == false' "$(unit journal)"
check_jq "a memory file that is gone is reported, not uploaded" '.result.ok == false and .calls == 0' "$(unit missing-file)"
check_jq "a local path with spaces reaches aws as one argument" '.result.ok == true and .calls == 1' "$(unit space-name)"
check_jq "a removal and an upload are two calls" '.result.ok == true and .calls == 2' "$(unit valid-nested)"
check "argv is the absolute local path (spaces and metacharacters intact), the s3 URI under the prefix, and the flag" grep -qxF "$(argline s3 cp "$workspace/memory/acme/api/scripts/ok.sh" s3://acme-sre-memory/fleet/acme/api/scripts/ok.sh --only-show-errors)" "$ctl/aws_calls.log"
check "the removal is an s3 rm of the key" test "$(grep -F 'acme/api/NOTES.md' "$ctl/aws_calls.log" | tail -n 1)" = "$(argline s3 rm s3://acme-sre-memory/fleet/acme/api/NOTES.md --only-show-errors)"
check "no shell ran anything in these names" test -z "$(pwned)"
if [ "$(id -u)" -eq 0 ]; then
  echo "ok   skipped: a read-only workspace does not stop root"
else
  check_jq "a restore that cannot even stage is a failed try with a backoff, not an error before every request" '.first.skipped != null and .first.restored == null and .failures == 1 and (.second.skipped | contains("waiting")) and .calls == 0' "$(unit retry-throws)"
fi

echo "--- 3. no bucket: nothing is called, and the memory is saved as before ---"
reset_aws
fresh_workspace
seed_estate
start_fixture nobucket
queue_one h-nobucket
export STUB_OPENCODE_MEMORY=edit
BUCKET_V=""
run_runner nobucket
unset STUB_OPENCODE_MEMORY
check "a run with no bucket exits 0" test "$rc" -eq 0
check "no bucket: aws is never called" test "$(calls)" -eq 0
check "no bucket: the edits still reach memory/_estate" test -f "$workspace/memory/_estate/scripts/check.sh"
stop_fixture

echo "--- 4. an empty memory directory is restored once, before the first poll ---"
reset_aws
fresh_workspace
bucket_tree="$ctl/bucket_tree"
mkdir -p "$bucket_tree/_estate" "$bucket_tree/acme/api/scripts"
printf '# Estate\n\nrestored: the nightly page goes to the on-call.\n' > "$bucket_tree/_estate/NOTES.md"
printf '# Notes\n\nrestored: pool ceiling is 40.\n' > "$bucket_tree/acme/api/NOTES.md"
printf '#!/usr/bin/env bash\n# checks the pool\necho ok\n' > "$bucket_tree/acme/api/scripts/check.sh"
printf 'data, not a script\n' > "$bucket_tree/acme/api/scripts/data.txt"
start_fixture restore
queue_one h-restore
BUCKET_V="acme-sre-memory"
PREFIX_V="team-a/memory"
run_runner restore
check "a restoring run exits 0" test "$rc" -eq 0
check "exactly one aws call on start (nothing changed, so nothing is mirrored)" test "$(calls)" -eq 1
check "the call is one recursive cp of the prefix into a staging directory beside memory/, never into memory/ itself" restore_call "$(call_line 1)" s3://acme-sre-memory/team-a/memory/
check "the staging directory is gone and memory/ holds the judged tree" no_staging
check "the bucket was read before the runner's first request to the platform" test "$(seen_at 1)" -eq 0
check "the estate's restored note is in the prompt" grep -qF 'restored: the nightly page goes to the on-call.' "$brief_seen"
check "the restored files are on the volume" test -f "$workspace/memory/acme/api/NOTES.md" -a -f "$workspace/memory/acme/api/scripts/check.sh"
check "the log says how many files came back" grep -qF 'restored 4 memory files from s3://acme-sre-memory/team-a/memory/' "$out"
check "a restored directory is closed to other accounts" test "$(stat -c %a "$workspace/memory/acme/api")" = "700"
check "a restored note is 0600" test "$(stat -c %a "$workspace/memory/acme/api/NOTES.md")" = "600"
check "a restored script with a shebang is executable by its owner only" test "$(stat -c %a "$workspace/memory/acme/api/scripts/check.sh")" = "700"
check "a restored file without a shebang is not executable" test "$(stat -c %a "$workspace/memory/acme/api/scripts/data.txt")" = "600"
check "no shell ran anything in the workspace name" test -z "$(pwned)"
stop_fixture

echo "--- 5. a memory directory that has something in it is never restored over ---"
reset_aws
mkdir -p "$ctl/bucket_tree/_estate"
printf '# Estate\n\nrestored: a different note.\n' > "$ctl/bucket_tree/_estate/NOTES.md"
mkdir -p "$workspace/memory/_estate.sre-agent-new-77"
printf 'half written\n' > "$workspace/memory/_estate.sre-agent-new-77/NOTES.md"
start_fixture nonempty
queue_one h-nonempty
run_runner nonempty
check "a non-empty memory directory: no aws call at all" test "$(calls)" -eq 0
check "the volume's own note stands" grep -qF 'restored: the nightly page goes to the on-call.' "$workspace/memory/_estate/NOTES.md"
check "a stale save directory is removed on start" test ! -e "$workspace/memory/_estate.sre-agent-new-77"
stop_fixture

echo "--- 6. a tampered bucket cannot put anything out of bounds on the volume ---"
reset_aws
fresh_workspace
bucket_tree="$ctl/bucket_tree"
mkdir -p "$bucket_tree"
t="$bucket_tree"
mkdir -p "$t/_estate" "$t/acme/api/scripts" "$t/acme/oversize" "$t/acme/many/scripts" "$t/acme/big/scripts" \
  "$t/acme/fifo/scripts" "$t/acme/swapped" "$t/acme/api/scripts/sub" "$t/repos/x" "$t/gitdirs/x" "$t/agent-home/x" \
  "$t/scratch/x" "$t/memory/x" "$t/acme/api.sre-agent-new-123" "$t/_estate.sre-agent-old-99" "$t/acme/extra"
printf '# Estate\n\nvalid\n' > "$t/_estate/NOTES.md"
printf '# Notes\n\nvalid\n' > "$t/acme/api/NOTES.md"
printf '#!/bin/sh\n# valid\n' > "$t/acme/api/scripts/ok.sh"
ln -s /etc/passwd "$t/acme/api/scripts/link.sh"
printf 'extra\n' > "$t/acme/api/extra.txt"
printf 'x\n' > "$t/acme/api/scripts/bad name"
printf 'x\n' > "$t/acme/api/scripts/semi;colon"
printf 'x\n' > "$t/acme/api/scripts/$(printf 'n%.0s' $(seq 1 101))"
printf 'x\n' > "$t/acme/api/scripts/sub/deep.sh"
head -c 70000 /dev/zero | tr '\0' 'a' > "$t/acme/oversize/NOTES.md"
for number in $(seq -w 1 51); do printf '#!/bin/sh\n' > "$t/acme/many/scripts/s$number"; done
head -c 600000 /dev/zero | tr '\0' 'a' > "$t/acme/big/scripts/a"
head -c 600000 /dev/zero | tr '\0' 'b' > "$t/acme/big/scripts/b"
mkfifo "$t/acme/fifo/scripts/pipe"
printf '# fifo repo\n' > "$t/acme/fifo/NOTES.md"
ln -s "$work/outside" "$t/acme/dirlink"
ln -s "$work/outside" "$t/evil"
ln -s "$work/outside" "$t/acme/swapped/scripts"
ln -s /etc/hostname "$t/acme/swapped/NOTES.md"
for reserved in repos gitdirs agent-home scratch memory; do printf 'reserved\n' > "$t/$reserved/x/NOTES.md"; done
printf 'stray\n' > "$t/stray.txt"
printf 'half\n' > "$t/acme/api.sre-agent-new-123/NOTES.md"
printf 'half\n' > "$t/_estate.sre-agent-old-99/NOTES.md"
printf 'extra\n' > "$t/acme/extra/NOTES.md.bak"
start_fixture tampered
queue_one h-tampered
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_runner tampered
check "a run after a tampered restore exits 0 and answers" test "$rc" -eq 0 -a -n "$report"
check "no symlink is left under memory/" test -z "$(find "$workspace/memory" -type l -print -quit)"
check "no FIFO or other special file is left under memory/" test -z "$(find "$workspace/memory" ! -type f ! -type d -print -quit)"
check "nothing outside the workspace's memory was written through a link" test "$(cat "$work/outside/precious")" = "do not touch" -a "$(find "$work/outside" -type f | wc -l)" -eq 1
check "an owner named like a workspace directory is restored under memory/ and nowhere else" test -f "$workspace/memory/repos/x/NOTES.md" -a -f "$workspace/memory/gitdirs/x/NOTES.md" -a -f "$workspace/memory/agent-home/x/NOTES.md" -a -f "$workspace/memory/scratch/x/NOTES.md" -a -f "$workspace/memory/memory/x/NOTES.md" -a ! -e "$workspace/repos" -a ! -e "$workspace/gitdirs" -a ! -e "$workspace/agent-home"
check "the top of memory/ holds only the estate and the owners (five of them named like workspace directories)" test "$(find "$workspace/memory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" = "_estate acme agent-home gitdirs memory repos scratch "
check "the valid estate note survived" grep -qx 'valid' "$workspace/memory/_estate/NOTES.md"
check "the valid repository note and script survived" test -f "$workspace/memory/acme/api/NOTES.md" -a -f "$workspace/memory/acme/api/scripts/ok.sh"
check "the repository holds exactly its note and its script" test "$(cd "$workspace/memory/acme/api" && find . -type f | LC_ALL=C sort | tr '\n' ' ')" = "./NOTES.md ./scripts/ok.sh "
check "an oversize NOTES.md with nothing to fall back to is removed" test ! -e "$workspace/memory/acme/oversize"
check "of 51 scripts the 51st is cut and 50 stay" test "$(find "$workspace/memory/acme/many/scripts" -type f | wc -l)" -eq 50 -a ! -e "$workspace/memory/acme/many/scripts/s51" -a -f "$workspace/memory/acme/many/scripts/s50"
check "two scripts that together pass 1 MiB are cut to one" test "$(find "$workspace/memory/acme/big" -type f | wc -l)" -eq 1
check "a FIFO is dropped and its repository's note stays" test ! -e "$workspace/memory/acme/fifo/scripts/pipe" -a -f "$workspace/memory/acme/fifo/NOTES.md"
check "a symlinked repository, owner, scripts directory and notes file are all gone" test ! -e "$workspace/memory/acme/dirlink" -a ! -e "$workspace/memory/evil" -a ! -e "$workspace/memory/acme/swapped"
check "a leftover of a stopped save is not restored" test ! -e "$workspace/memory/acme/api.sre-agent-new-123" -a ! -e "$workspace/memory/_estate.sre-agent-old-99"
check "a stray top-level file is gone" test ! -e "$workspace/memory/stray.txt"
restored_files="$(find "$workspace/memory" -type f | wc -l)"
check "the log counts what was kept ($restored_files files) and what it cut" grep -qF "restored ${restored_files} memory files" "$out"
check "the log says what was cut" grep -qF 'was removed' "$out"
check "every directory is 0700 and every file 0600 or 0700" test -z "$(find "$workspace/memory" -mindepth 1 \( -type d ! -perm 700 \) -o \( -type f ! -perm 600 ! -perm 700 \) -print -quit)"
check "no shell ran anything in the workspace name" test -z "$(pwned)"
stop_fixture

echo "--- 7. a failing download restores nothing, never stops the runner, and is tried again at the next start ---"
reset_aws
fresh_workspace
mkdir -p "$ctl/bucket_tree/_estate"
printf '# Estate\n\nvalid\n' > "$ctl/bucket_tree/_estate/NOTES.md"
: > "$ctl/aws_partial_fail"
start_fixture failing_restore
queue_one h-failing-restore
run_runner failing_restore
check "a failing restore still exits 0 and answers the request" test "$rc" -eq 0 -a -n "$report"
check "the log says the memory was not restored, with the aws error" grep -qF 'AccessDenied' "$out"
check "a partial download is not left on the volume" test -z "$(find "$workspace/memory" -type f -print -quit)"
stop_fixture
rm -f "$ctl/aws_partial_fail"
: > "$ctl/aws_calls.log"
start_fixture retried_restore
queue_one h-retried-restore
run_runner retried_restore
check "the next start restores, because the volume was left empty" test -f "$workspace/memory/_estate/NOTES.md"
stop_fixture

echo "--- 8. after a run with changes: one cp per added or modified file, one rm per removed one, before the report ---"
reset_aws
fresh_workspace
seed_estate
start_fixture mirror
queue_one h-mirror
export STUB_OPENCODE_MEMORY=edit STUB_OPENCODE_MEMORY_SUMMARY="Estate note added."
BUCKET_V="acme-sre-memory"
PREFIX_V="fleet"
run_driver mirror
unset STUB_OPENCODE_MEMORY STUB_OPENCODE_MEMORY_SUMMARY
estate="$workspace/memory/_estate"
check "the run exits 0" test "$rc" -eq 0
check "the memory is not empty at start, so there is no download" test -z "$(grep -F -- '--recursive' "$ctl/aws_calls.log" || true)"
check "three calls: two uploads and one removal" test "$(calls)" -eq 3
check "the modified note is uploaded under the prefix" test "$(call_line 1)" = "$(argline s3 cp "$estate/NOTES.md" s3://acme-sre-memory/fleet/_estate/NOTES.md --only-show-errors)"
check "the added script is uploaded" test "$(call_line 2)" = "$(argline s3 cp "$estate/scripts/check.sh" s3://acme-sre-memory/fleet/_estate/scripts/check.sh --only-show-errors)"
check "the removed script is deleted from the bucket" test "$(call_line 3)" = "$(argline s3 rm s3://acme-sre-memory/fleet/_estate/scripts/old.sh --only-show-errors)"
check "the uploaded note is the saved note" cmp -s "$ctl/uploaded/acme-sre-memory/fleet/_estate/NOTES.md" "$estate/NOTES.md"
check "the uploaded script is the saved script" cmp -s "$ctl/uploaded/acme-sre-memory/fleet/_estate/scripts/check.sh" "$estate/scripts/check.sh"
check "what the runner cut (a symlink, a bad name, a stray file) is never uploaded" test -z "$(grep -E 'link.sh|bad name|stray' "$ctl/aws_calls.log" || true)"
check "every call was made after the brief was fetched and before the report was posted" test "$(sort -u "$ctl/aws_seen.log" | tr '\n' ' ')" = "1 "
check_jqf "the run's result carries the mirror's answer for the report" '.mirror.ok == true' "$work/mirror.result.json"
check_jq "the report's memory names the bucket, beside the changes and the summary" '.memory.bucket == "acme-sre-memory" and (.memory.changes | length) == 3 and .memory.summary == "Estate note added."' "$report"
check "every aws call saw the AWS variables and none of the runner's other credentials" test "$(sort -u "$ctl/aws_env.log" | grep -v '^$' | tr '\n' '|')" = "AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY |"
check "the agent's environment holds no SRE_MEMORY_ variable" grep -qx 'memory_env: ' "$opencode_log"
check "the AWS secret is in no log line and no report" test -z "$(grep -lF "$aws_secret" "$work"/*.out "$fixture_log" 2>/dev/null || true)"
check "no shell ran anything in the workspace name" test -z "$(pwned)"
stop_fixture

echo "--- 9. a run with no change makes no call ---"
reset_aws
start_fixture quiet
queue_one h-quiet
run_driver quiet
check "an unchanged memory calls aws zero times" test "$(calls)" -eq 0
check_jqf "and the result has no mirror answer" '.mirror == null' "$work/quiet.result.json"
stop_fixture

echo "--- 10. a failing aws call is logged and never fails the request ---"
reset_aws
fresh_workspace
seed_estate
printf 'NOTES.md' > "$ctl/aws_fail_on"
start_fixture failing_mirror
queue_one h-failing-mirror
export STUB_OPENCODE_MEMORY=edit
run_driver failing_mirror
unset STUB_OPENCODE_MEMORY
check "the run still exits 0" test "$rc" -eq 0
check "the request is still reported" test "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check "the other files were still tried" test "$(calls)" -eq 3
check_jqf "the result says the mirror failed, naming the file and the aws error" '.mirror.ok == false and (.mirror.error | contains("_estate/NOTES.md") and contains("AccessDenied"))' "$work/failing_mirror.result.json"
check_jqf "the error is short enough for the report's detail" '(.mirror.error | length) <= 300' "$work/failing_mirror.result.json"
check "the failure is in the log" grep -qF 'AccessDenied' "$work/failing_mirror.out"
check "the memory on the volume is untouched by the failure" test -f "$workspace/memory/_estate/scripts/check.sh"
stop_fixture
reset_aws
fresh_workspace
seed_estate
printf '' > "$ctl/aws_fail_on"
touch "$ctl/aws_fail"
start_fixture all_failing
queue_one h-all-failing
export STUB_OPENCODE_MEMORY=edit
run_driver all_failing
unset STUB_OPENCODE_MEMORY
check "every call failing still exits 0 with the request reported" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check_jqf "and the result says how many of the calls failed" '.mirror.ok == false and (.mirror.error | contains("3 of 3"))' "$work/all_failing.result.json"
stop_fixture

echo "--- 10b. a memory directory that cannot be saved mirrors nothing ---"
if [ "$(id -u)" -eq 0 ]; then
  echo "ok   skipped: a read-only directory does not stop root"
else
  reset_aws
  fresh_workspace
  seed_estate
  original_note="$(cat "$workspace/memory/_estate/NOTES.md")"
  write_sync_marker acme-sre-memory fleet/
  chmod 500 "$workspace/memory"
  start_fixture unsaved
  queue_one h-unsaved
  export STUB_OPENCODE_MEMORY=edit
  run_driver unsaved
  unset STUB_OPENCODE_MEMORY
  chmod 700 "$workspace/memory"
  check "the request is still reported" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
  check "the log says the memory could not be saved" grep -qF 'could not be saved' "$work/unsaved.out"
  check "the earlier note stands" test "$(cat "$workspace/memory/_estate/NOTES.md")" = "$original_note"
  check_jqf "no change is reported for it" '.changes == []' "$work/unsaved.result.json"
  check_jq "and the report body carries no memory key" 'has("memory") | not' "$report"
  check "nothing is mirrored for a save that did not happen" test "$(calls)" -eq 0
  check_jqf "and the result has no mirror answer" '.mirror == null' "$work/unsaved.result.json"
  stop_fixture
fi

echo "--- 12. a restore that is interrupted never leaves unjudged content in memory/, and the next start restores in full ---"
reset_aws
fresh_workspace
t="$ctl/bucket_tree"
mkdir -p "$t/_estate" "$t/acme/api/scripts" "$t/acme/never-opened/scripts"
printf '# Estate\n\nvalid\n' > "$t/_estate/NOTES.md"
head -c 70000 /dev/zero | tr '\0' 'a' > "$t/acme/api/NOTES.md"
printf '#!/bin/sh\n# truncated by the stop\n' > "$t/acme/api/scripts/check.sh.aB3dE9f0"
head -c 2000000 /dev/zero | tr '\0' 'a' > "$t/acme/never-opened/scripts/x"
printf 'stray\n' > "$t/stray.txt"
: > "$ctl/aws_kill_runner"
start_fixture interrupted
queue_one h-interrupted
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_runner interrupted
check "the runner was stopped between the download and the judging" test "$rc" -ne 0
check "the download was made (so the stop fell where it is claimed to)" test "$(calls)" -eq 1
check "nothing from the interrupted download is in memory/" test -z "$(find "$workspace/memory" -mindepth 1 -print -quit 2>/dev/null)"
stop_fixture
rm -rf "$t"
rm -f "$ctl/aws_kill_runner"
mkdir -p "$t/_estate" "$t/acme/api/scripts" "$t/acme/oversize"
printf '# Estate\n\nvalid\n' > "$t/_estate/NOTES.md"
printf '# Notes\n\nvalid api note\n' > "$t/acme/api/NOTES.md"
printf '#!/bin/sh\n# valid\n' > "$t/acme/api/scripts/check.sh"
head -c 70000 /dev/zero | tr '\0' 'a' > "$t/acme/oversize/NOTES.md"
printf 'stray\n' > "$t/stray.txt"
start_fixture resumed
queue_one h-resumed
run_runner resumed
check "the next start exits 0 and answers" test "$rc" -eq 0 -a -n "$report"
check "the next start restores the whole tree" test -f "$workspace/memory/_estate/NOTES.md" -a -f "$workspace/memory/acme/api/NOTES.md" -a -f "$workspace/memory/acme/api/scripts/check.sh"
check "and judges it: the oversize note, the stray file and the truncated temp file are not on the volume" test ! -e "$workspace/memory/acme/oversize" -a ! -e "$workspace/memory/stray.txt" -a ! -e "$workspace/memory/acme/api/scripts/check.sh.aB3dE9f0" -a ! -e "$workspace/memory/acme/never-opened"
check "the stopped restore's staging directory is gone" no_staging
check "and the restore is no longer pending" test ! -e "$workspace/.memory-restore-pending"
stop_fixture

echo "--- 13. a failed restore followed by a job: the bucket's copy is not overwritten, and the restore is retried with the volume winning ---"
reset_aws
fresh_workspace
t="$ctl/bucket_tree"
mkdir -p "$t/_estate/scripts" "$t/acme/api"
printf '# Estate\n\nbucket copy of the estate note\n' > "$t/_estate/NOTES.md"
printf '#!/bin/sh\n# bucket helper\n' > "$t/_estate/scripts/old.sh"
printf '# api\n\nbucket copy of the api note\n' > "$t/acme/api/NOTES.md"
printf -- '--recursive' > "$ctl/aws_fail_on"
start_fixture pending_one
queue_one h-pending-one
export STUB_OPENCODE_MEMORY=edit
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_driver pending_one
unset STUB_OPENCODE_MEMORY
check "the job is answered" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check "the restore is tried at start and again before the job" test "$(grep -c -- '--recursive' "$ctl/aws_calls.log")" -eq 2
check "no file is put into the bucket and none is deleted from it while the restore is pending" test -z "$(grep -v -- '--recursive' "$ctl/aws_calls.log" || true)"
check "the bucket's copy is untouched" test ! -e "$ctl/uploaded"
check_jqf "the result says nothing was mirrored because the restore has not succeeded" '.mirror.ok == false and (.mirror.error | contains("restore"))' "$work/pending_one.result.json"
check "the job's note is on the volume" grep -qF 'pool ceiling is 40' "$workspace/memory/_estate/NOTES.md"
check "the paths still to mirror are kept on the volume" grep -qF '_estate/NOTES.md' "$workspace/.memory-mirror-pending"
check "the pending restore is recorded on the volume" test -e "$workspace/.memory-restore-pending"
stop_fixture
rm -f "$ctl/aws_fail_on"
: > "$ctl/aws_calls.log"
: > "$ctl/aws_seen.log"
start_fixture pending_two
queue_one h-pending-two
run_driver pending_two
check "the next start retries the restore although memory/ is no longer empty" test "$(grep -c -- '--recursive' "$ctl/aws_calls.log")" -eq 1
check "the volume's own note wins over the bucket's" grep -qF 'pool ceiling is 40' "$workspace/memory/_estate/NOTES.md"
check "the bucket's older estate note did not replace it" test -z "$(grep -F 'bucket copy of the estate note' "$workspace/memory/_estate/NOTES.md" || true)"
check "a file the volume lacks comes back from the bucket (the estate helper and the other repository's note)" test -f "$workspace/memory/_estate/scripts/old.sh" -a -f "$workspace/memory/acme/api/NOTES.md"
check "the volume's script from the first job is kept" test -f "$workspace/memory/_estate/scripts/check.sh"
check_jqf "the job mirrors what the first job left pending: two uploads" '.mirror.ok == true and .mirror.calls == 2' "$work/pending_two.result.json"
check "the uploaded note is the volume's note" cmp -s "$ctl/uploaded/acme-sre-memory/memory/_estate/NOTES.md" "$workspace/memory/_estate/NOTES.md"
check "what came back from the bucket is not uploaded again" test ! -e "$ctl/uploaded/acme-sre-memory/memory/acme"
check "no journal and no pending restore are left" test ! -e "$workspace/.memory-mirror-pending" -a ! -e "$workspace/.memory-restore-pending"
stop_fixture

echo "--- 14. a restore that fails once is retried before the first job in the same process ---"
reset_aws
fresh_workspace
mkdir -p "$ctl/bucket_tree/_estate"
printf '# Estate\n\nrestored by the retry before the job\n' > "$ctl/bucket_tree/_estate/NOTES.md"
echo 1 > "$ctl/aws_fail_first"
start_fixture retried_before_job
queue_one h-retried-before-job
run_runner retried_before_job
check "two downloads: the one at start fails, the one before the job works" test "$(grep -c -- '--recursive' "$ctl/aws_calls.log")" -eq 2
check "the second download ran before the brief was fetched (only the queue had been asked)" test "$(seen_at 2)" -eq 1
check "the estate note reached the agent's prompt" grep -qF 'restored by the retry before the job' "$brief_seen"
check "the restore is no longer pending" test ! -e "$workspace/.memory-restore-pending"
stop_fixture

echo "--- 15. more than fifty changes: every one is mirrored, and the report still carries at most fifty ---"
reset_aws
fresh_workspace
mkdir -p "$workspace/memory/_estate/scripts"
printf '# Estate\n\nthe first note\n' > "$workspace/memory/_estate/NOTES.md"
for number in $(seq -w 1 50); do printf '#!/bin/sh\n# a%s\n' "$number" > "$workspace/memory/_estate/scripts/a$number"; done
start_fixture churn
queue_one h-churn
export STUB_OPENCODE_MEMORY=churn
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_driver churn
unset STUB_OPENCODE_MEMORY
check "the run exits 0" test "$rc" -eq 0
check_jqf "the report's list is cut to fifty" '(.changes | length) == 50' "$work/churn.result.json"
check "all 101 changes made a call" test "$(calls)" -eq 101
check "the 50 scripts the run removed were deleted from the bucket" test "$(grep -c "^s3${us}rm${us}s3://acme-sre-memory/memory/_estate/scripts/a" "$ctl/aws_calls.log")" -eq 50
check "the 50 scripts the run added and the changed note were uploaded" test "$(find "$ctl/uploaded" -type f | wc -l)" -eq 51
check "the last of the added scripts is among them" test -f "$ctl/uploaded/acme-sre-memory/memory/_estate/scripts/b50"
check_jqf "and the mirror says it made them all" '.mirror.ok == true and .mirror.calls == 101' "$work/churn.result.json"
check_jq "the report body itself carries fifty changes and the bucket's name" '(.memory.changes | length) == 50 and .memory.bucket == "acme-sre-memory"' "$report"
stop_fixture

echo "--- 16. a bucket that never answers: the mirror stops at its limit, the report goes out, the next job mirrors what is left ---"
reset_aws
fresh_workspace
seed_estate
: > "$ctl/aws_hang"
start_fixture hang
queue_one h-hang
export STUB_OPENCODE_MEMORY=edit
driver_deadline_ms=3000
SECONDS=0
run_driver hang
elapsed=$SECONDS
unset STUB_OPENCODE_MEMORY driver_deadline_ms
check "the run exits 0 and the request is reported" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check "the whole run, mirror included, ended within seconds of the limit ($elapsed s)" test "$elapsed" -lt 40
check "the mirror gave up after the first call that did not answer" test "$(calls)" -eq 1
check_jqf "the result says what was not tried and why" '.mirror.ok == false and (.mirror.error | contains("2 of 3 not tried"))' "$work/hang.result.json"
check "the three paths wait in the journal" jq -e '.paths | length == 3' "$workspace/.memory-mirror-pending"
check "nothing reached the bucket" test ! -e "$ctl/uploaded"
stop_fixture
rm -f "$ctl/aws_hang"
: > "$ctl/aws_calls.log"
start_fixture hang_next
queue_one h-hang-next
run_driver hang_next
check "the next job, with no change of its own, mirrors the pending paths" test "$(calls)" -eq 3
check_jqf "and says so" '.mirror.ok == true and .mirror.calls == 3' "$work/hang_next.result.json"
check "the note and the script reached the bucket and the removed script is gone from it" test -s "$ctl/uploaded/acme-sre-memory/memory/_estate/NOTES.md" -a -s "$ctl/uploaded/acme-sre-memory/memory/_estate/scripts/check.sh"
check "the journal is empty again" test ! -e "$workspace/.memory-mirror-pending"
stop_fixture

echo "--- 16b. slow calls: the limit cuts the run part way, and what it cut stays pending ---"
reset_aws
fresh_workspace
seed_estate
echo 1 > "$ctl/aws_sleep"
start_fixture slow
queue_one h-slow
export STUB_OPENCODE_MEMORY=edit
driver_deadline_ms=2500
run_driver slow
unset STUB_OPENCODE_MEMORY driver_deadline_ms
check "two calls finished inside the limit and the third was cut" test "$(find "$ctl/uploaded" -type f | wc -l)" -eq 2
check_jqf "the result counts one path still pending" '.mirror.ok == false and .mirror.pending == 1' "$work/slow.result.json"
check "one path waits in the journal" jq -e '.paths | length == 1' "$workspace/.memory-mirror-pending"
stop_fixture

echo "--- 17. the CLI exits 2 for a key it skipped: what it did download is kept, judged, and the skip is logged ---"
reset_aws
fresh_workspace
mkdir -p "$ctl/bucket_tree/_estate" "$ctl/bucket_tree/acme/api"
printf '# Estate\n\nkept despite the skipped key\n' > "$ctl/bucket_tree/_estate/NOTES.md"
printf 'stray\n' > "$ctl/bucket_tree/stray.txt"
: > "$ctl/aws_exit2"
start_fixture exit_two
queue_one h-exit-two
run_runner exit_two
check "the run exits 0" test "$rc" -eq 0
check "what downloaded is on the volume" grep -qF 'kept despite the skipped key' "$workspace/memory/_estate/NOTES.md"
check "and was judged like any other restore" test ! -e "$workspace/memory/stray.txt"
check "the log names what the CLI skipped" grep -qF 'File references a parent directory' "$out"
check "the restore is not left pending" test ! -e "$workspace/.memory-restore-pending"
check "the restore ran once, it was not repeated at the next job" test "$(calls)" -eq 1
stop_fixture

echo "--- 18. a repository job is mirrored under <owner>/<repo>/ ---"
real_git="$(command -v git)"
remote="$work/remote/app.git"
mkdir -p "$work/remote" "$work/gitbin"
"$real_git" init -q --bare -b main "$remote"
"$real_git" init -q -b main "$work/seed"
printf 'the fixture repository\n' > "$work/seed/README.md"
"$real_git" -C "$work/seed" add README.md
"$real_git" -C "$work/seed" -c user.name=seed -c user.email=seed@example.invalid commit -q -m seed
"$real_git" -C "$work/seed" push -q "$remote" main
cat > "$work/gitbin/git" <<GITEOF
#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "\$@"; do
  case "\$a" in
    https://x-access-token:*@github.com/*) args+=("$remote") ;;
    *) args+=("\$a") ;;
  esac
done
exec "$real_git" "\${args[@]}"
GITEOF
chmod +x "$work/gitbin/git"
PATH="$work/gitbin:$PATH"
reset_aws
fresh_workspace
start_fixture repo_job
jq -n --arg id h-repo --arg base "$server_url" --arg token "$handoff_token" \
  '[{handoff_id: $id, subject_id: "11111111-2222-3333-4444-555555555555", repo_full_name: "acme/app",
     brief_url: ($base + "/api/handoffs/" + $id + "/brief"), report_url: ($base + "/api/handoffs/" + $id + "/report"), token: $token}]' > "$queue_file"
export STUB_OPENCODE_MEMORY=edit
run_driver repo_job
unset STUB_OPENCODE_MEMORY
check "the repository job exits 0" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check "the note is on the volume under the owner and the repository" test -f "$workspace/memory/acme/app/NOTES.md"
check "the note was uploaded under the prefix, the owner and the repository" cmp -s "$ctl/uploaded/acme-sre-memory/memory/acme/app/NOTES.md" "$workspace/memory/acme/app/NOTES.md"
check "the script was uploaded there too" test -s "$ctl/uploaded/acme-sre-memory/memory/acme/app/scripts/check.sh"
check "the empty volume was restored once, then two uploads and nothing else" test "$(grep -c -- '--recursive' "$ctl/aws_calls.log")" -eq 1 -a "$(grep -vc -- '--recursive' "$ctl/aws_calls.log")" -eq 2
check "nothing went to the estate's key" test ! -e "$ctl/uploaded/acme-sre-memory/memory/_estate"
stop_fixture

echo "--- 19. the first sync: memory that was never mirrored is uploaded once, deletes nothing, and a cut sync finishes on the next job ---"
seed_three() {
  seed_estate
  mkdir -p "$workspace/memory/acme/api"
  printf '# api\n\nan existing note\n' > "$workspace/memory/acme/api/NOTES.md"
}
reset_aws
fresh_workspace
seed_three
start_fixture first_sync
queue_one h-first-sync
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_driver first_sync
check "the run exits 0" test "$rc" -eq 0
check "existing memory is not restored over: no download" test -z "$(grep -F -- '--recursive' "$ctl/aws_calls.log" || true)"
check "one put per existing file, three in all" test "$(grep -c "^s3${us}cp${us}" "$ctl/aws_calls.log")" -eq 3 -a "$(calls)" -eq 3
check "the sync deletes nothing in the bucket" test -z "$(grep -F "s3${us}rm${us}" "$ctl/aws_calls.log" || true)"
check "every file is in the bucket under the prefix" test -s "$ctl/uploaded/acme-sre-memory/memory/_estate/NOTES.md" -a -s "$ctl/uploaded/acme-sre-memory/memory/_estate/scripts/old.sh" -a -s "$ctl/uploaded/acme-sre-memory/memory/acme/api/NOTES.md"
check_jqf "and the result says the mirror made all three calls" '.mirror.ok == true and .mirror.calls == 3 and .mirror.pending == 0' "$work/first_sync.result.json"
check "the marker of a finished sync is on the volume" test -e "$workspace/.memory-first-sync"
check "and no journal is left" test ! -e "$workspace/.memory-mirror-pending"
stop_fixture
: > "$ctl/aws_calls.log"
start_fixture first_sync_again
queue_one h-first-sync-again
run_driver first_sync_again
check "a second start does nothing: no aws call" test "$(calls)" -eq 0
check_jqf "and the result has no mirror answer" '.mirror == null' "$work/first_sync_again.result.json"
stop_fixture

reset_aws
fresh_workspace
seed_three
echo 1 > "$ctl/aws_sleep"
start_fixture first_sync_cut
queue_one h-first-sync-cut
driver_deadline_ms=2500
run_driver first_sync_cut
unset driver_deadline_ms
check "the deadline cut the sync part way: two files are in the bucket" test "$(find "$ctl/uploaded" -type f 2>/dev/null | wc -l)" -eq 2
check_jqf "the result counts one path still pending" '.mirror.ok == false and .mirror.pending == 1' "$work/first_sync_cut.result.json"
check "the marker is not written while the journal holds a path" test ! -e "$workspace/.memory-first-sync"
check "one path waits in the journal" jq -e '.paths | length == 1' "$workspace/.memory-mirror-pending"
stop_fixture
rm -f "$ctl/aws_sleep"
start_fixture first_sync_rest
queue_one h-first-sync-rest
run_driver first_sync_rest
check "the next job finishes the sync: all three files are in the bucket" test "$(find "$ctl/uploaded" -type f | wc -l)" -eq 3
check_jqf "and says so" '.mirror.ok == true and .mirror.pending == 0' "$work/first_sync_rest.result.json"
check "the marker is written once the journal is empty" test -e "$workspace/.memory-first-sync" -a ! -e "$workspace/.memory-mirror-pending"
stop_fixture

reset_aws
fresh_workspace
start_fixture first_sync_empty
queue_one h-first-sync-empty
run_driver first_sync_empty
check "an empty volume is restored from the empty bucket, which is a synced volume: the one download, no put, and the marker" test "$(calls)" -eq 1 -a -e "$workspace/.memory-first-sync"
stop_fixture

echo "--- 20. the first sync uploads only what passes the memory bounds ---"
reset_aws
fresh_workspace
m="$workspace/memory"
mkdir -p "$m/acme/note/scripts" "$m/acme/huge/scripts" "$m/acme/many/scripts" "$m/acme/mix/scripts" "$m/acme/fine/scripts" "$m/acme/odd/scripts"
head -c 70000 /dev/zero | tr '\0' 'a' > "$m/acme/note/NOTES.md"
printf '#!/bin/sh\n# ok\n' > "$m/acme/note/scripts/ok.sh"
head -c 2000000 /dev/zero | tr '\0' 'a' > "$m/acme/huge/scripts/huge.sh"
printf '#!/bin/sh\n# ok\n' > "$m/acme/huge/scripts/ok.sh"
for number in $(seq -w 1 60); do printf '#!/bin/sh\n' > "$m/acme/many/scripts/s$number"; done
head -c 70000 /dev/zero | tr '\0' 'a' > "$m/acme/mix/NOTES.md"
head -c 2000000 /dev/zero | tr '\0' 'a' > "$m/acme/mix/scripts/huge.sh"
for number in $(seq -w 1 60); do printf '#!/bin/sh\n' > "$m/acme/mix/scripts/s$number"; done
printf '# fine\n\nwithin every bound\n' > "$m/acme/fine/NOTES.md"
printf '#!/bin/sh\n# fine\n' > "$m/acme/fine/scripts/ok.sh"
mkfifo "$m/acme/odd/scripts/pipe"
ln -s /etc/hostname "$m/acme/odd/scripts/link.sh"
printf '#!/bin/sh\n' > "$m/acme/odd/scripts/bad name"
printf '#!/bin/sh\n' > "$m/acme/odd/scripts/ok.sh"
start_fixture bounded_sync
queue_one h-bounded-sync
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_driver bounded_sync
up="$ctl/uploaded/acme-sre-memory/memory/acme"
uploaded_in() { find "$up/$1" -type f 2>/dev/null | wc -l; }
check "the run exits 0" test "$rc" -eq 0
check "an oversize NOTES.md is not uploaded, and the script beside it is" test ! -e "$up/note/NOTES.md" -a -s "$up/note/scripts/ok.sh"
check "a script over the directory's byte limit is not uploaded, and the one beside it is" test ! -e "$up/huge/scripts/huge.sh" -a -s "$up/huge/scripts/ok.sh"
check "of 60 scripts in one directory 50 are uploaded, the first fifty by name" test "$(uploaded_in many)" -eq 50 -a -s "$up/many/scripts/s50" -a ! -e "$up/many/scripts/s51"
check "a directory with an oversize note, a 2 MB script and 60 scripts uploads neither the note nor the script, and 49 of the scripts (the 2 MB one held one of the fifty places before the size cut, as it does in a restore)" test ! -e "$up/mix/NOTES.md" -a ! -e "$up/mix/scripts/huge.sh" -a "$(uploaded_in mix)" -eq 49
check "a directory within every bound is uploaded whole" test -s "$up/fine/NOTES.md" -a -s "$up/fine/scripts/ok.sh"
check "a FIFO, a link and a name outside the allowed set are not uploaded" test "$(uploaded_in odd)" -eq 1 -a -s "$up/odd/scripts/ok.sh"
check "no file the volume holds beyond its bounds made an aws call" test "$(calls)" -eq "$(find "$ctl/uploaded" -type f | wc -l)"
check "the sync deletes nothing in the bucket" test -z "$(grep -F "s3${us}rm${us}" "$ctl/aws_calls.log" || true)"
check "the log says files were left out for breaking a bound, naming the first" grep -qF 'break the memory bounds and are not uploaded' "$work/bounded_sync.out"
check "the marker of a finished sync is on the volume" test -e "$workspace/.memory-first-sync" -a ! -e "$workspace/.memory-mirror-pending"
stop_fixture

echo "--- 21. the first-sync marker is for one bucket and prefix, and another bucket or prefix journals every file again ---"
reset_aws
fresh_workspace
seed_three
BUCKET_V="acme-sre-memory"
PREFIX_V=""
start_fixture marker_a
queue_one h-marker-a
run_driver marker_a
check "the first bucket gets the three files" test "$(find "$ctl/uploaded/acme-sre-memory/memory" -type f | wc -l)" -eq 3
check_jqf "the marker names the bucket and the prefix it was written for" '.target == "s3://acme-sre-memory/memory/"' "$workspace/.memory-first-sync"
stop_fixture
: > "$ctl/aws_calls.log"
start_fixture marker_same
queue_one h-marker-same
run_driver marker_same
check "the same bucket and prefix again: no call" test "$(calls)" -eq 0
stop_fixture
BUCKET_V="other-sre-memory"
start_fixture marker_b
queue_one h-marker-b
run_driver marker_b
check "a changed bucket journals every file again: three uploads to the new bucket" test "$(find "$ctl/uploaded/other-sre-memory/memory" -type f | wc -l)" -eq 3
check_jqf "and the marker now names the new bucket" '.target == "s3://other-sre-memory/memory/"' "$workspace/.memory-first-sync"
check "the new bucket's sync deleted nothing" test -z "$(grep -F "s3${us}rm${us}" "$ctl/aws_calls.log" || true)"
stop_fixture
PREFIX_V="team-b"
start_fixture marker_c
queue_one h-marker-c
run_driver marker_c
check "a changed prefix journals every file again: three uploads under the new prefix" test "$(find "$ctl/uploaded/other-sre-memory/team-b" -type f | wc -l)" -eq 3
check_jqf "and the marker names the new prefix" '.target == "s3://other-sre-memory/team-b/"' "$workspace/.memory-first-sync"
stop_fixture
rm -rf "$ctl/uploaded"
: > "$ctl/aws_calls.log"
: > "$workspace/.memory-first-sync"
start_fixture marker_empty
queue_one h-marker-empty
run_driver marker_empty
check "a marker that names no bucket (empty or from an earlier release) counts as no marker: three uploads" test "$(find "$ctl/uploaded/other-sre-memory/team-b" -type f | wc -l)" -eq 3
stop_fixture

echo "--- 22. a journal that cannot be read is logged and the volume is synced again ---"
reset_aws
fresh_workspace
seed_three
BUCKET_V="acme-sre-memory"
PREFIX_V=""
start_fixture journal_ok
queue_one h-journal-ok
run_driver journal_ok
check "a first sync completes: three files in the bucket and a marker" test "$(find "$ctl/uploaded" -type f | wc -l)" -eq 3 -a -e "$workspace/.memory-first-sync"
stop_fixture
rm -rf "$ctl/uploaded"
: > "$ctl/aws_calls.log"
printf '{"version":1,"paths":{"_estate/NO' > "$workspace/.memory-mirror-pending"
start_fixture journal_cut
queue_one h-journal-cut
run_driver journal_cut
check "the run exits 0 and answers" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check "the log says the journal could not be read" grep -qF 'could not be read' "$work/journal_cut.out"
check "and that every file is mirrored again" grep -qF 'mirrored again' "$work/journal_cut.out"
check "a truncated journal does not lose the paths: all three files are uploaded again" test "$(find "$ctl/uploaded" -type f | wc -l)" -eq 3
check "the unreadable journal is gone and the sync is complete" test ! -e "$workspace/.memory-mirror-pending" -a -e "$workspace/.memory-first-sync"
check_jqf "the marker is the new one" '.target == "s3://acme-sre-memory/memory/"' "$workspace/.memory-first-sync"
stop_fixture
rm -rf "$ctl/uploaded"
: > "$ctl/aws_calls.log"
rm -rf "$workspace/.memory-mirror-pending"
mkdir "$workspace/.memory-mirror-pending"
start_fixture journal_dir
queue_one h-journal-dir
run_driver journal_dir
check "a journal that is a directory is handled the same way: all three files are uploaded" test "$rc" -eq 0 -a "$(find "$ctl/uploaded" -type f | wc -l)" -eq 3
check "and the directory is gone" test ! -e "$workspace/.memory-mirror-pending"
stop_fixture

echo "--- 22b. the mirror's loop has no flag of its own for a call that timed out ---"
check "a call's time limit is the time left, so a call that times out leaves none and a flag could never matter" test -z "$(grep -nw stopped "$pkg/runner/bucket.js" || true)"

echo "--- 23. a test job writes a marker object to the bucket and removes it again, and says so ---"
reset_aws
fresh_workspace
start_fixture test_bucket
queue_test_job h-test-bucket ""
export STUB_OPENCODE_MODE=oneline
BUCKET_V="acme-sre-memory"
PREFIX_V="fleet"
run_driver test_bucket
estate_marker="$workspace/memory/_estate/scripts/.runner-test"
check "the job exits 0 and is reported as not_validated" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check_jq "every step passed, the bucket step among them" '.test.steps | map(.ok) == [true, true, true, true, true, true]' "$report"
check_jq "the bucket step names the bucket and the prefix" '.test.steps[4].detail | contains("s3://acme-sre-memory/fleet/")' "$report"
check "the marker was put under the prefix, in the estate's scripts" test "$(grep -cxF "$(argline s3 cp "$estate_marker" s3://acme-sre-memory/fleet/_estate/scripts/.runner-test --only-show-errors)" "$ctl/aws_calls.log")" -eq 1
check "and removed from the bucket" test "$(grep -cxF "$(argline s3 rm s3://acme-sre-memory/fleet/_estate/scripts/.runner-test --only-show-errors)" "$ctl/aws_calls.log")" -eq 1
check "the put came before the removal" test "$(grep -nF 's3'"$us"'cp'"$us$estate_marker" "$ctl/aws_calls.log" | head -n 1 | cut -d: -f1)" -lt "$(grep -nF 's3'"$us"'rm'"$us" "$ctl/aws_calls.log" | head -n 1 | cut -d: -f1)"
check "nothing is left in the bucket" test -z "$(find "$ctl/uploaded" -type f -print -quit 2>/dev/null)"
check "nothing is left on the volume: no marker, no directory the test made" test ! -e "$estate_marker" -a ! -e "$workspace/memory/_estate"
check "the mirror's calls were made after the brief was fetched and before the report was posted" test "$(tail -n 2 "$ctl/aws_seen.log" | sort -u | tr '\n' ' ')" = "1 "
check_jqf "the result carries the mirror's answer" '.mirror.ok == true and .mirror.pending == 0' "$work/test_bucket.result.json"
check "no journal and no pending path are left" test ! -e "$workspace/.memory-mirror-pending"
check "no shell ran anything in the workspace name" test -z "$(pwned)"
stop_fixture

echo "--- 23b. a bucket that refuses the marker fails the bucket step with the aws error, and the removal is retried by the next job ---"
reset_aws
fresh_workspace
printf '.runner-test' > "$ctl/aws_fail_on"
start_fixture test_bucket_denied
queue_test_job h-test-bucket-denied ""
run_driver test_bucket_denied
check "the job is still reported, as not_validated" test "$rc" -eq 0 -a "$(jq -r '.outcome' <<<"$report")" = "not_validated"
check_jq "the steps before the bucket pass, the bucket fails with the aws error, reported is ok" '(.test.steps | map(.ok) == [true, true, true, true, false, true]) and (.test.steps[4].detail | contains("AccessDenied")) and (.test.steps[4].detail | length) <= 300' "$report"
check_jq "the summary is one sentence naming the step" '(.summary | contains("the bucket step")) and (.summary | test("\n") | not)' "$report"
check "nothing was uploaded" test ! -e "$ctl/uploaded"
check "no marker file is left on the volume" test -z "$(find "$workspace/memory" -name '.runner-test' -print -quit 2>/dev/null)"
check_jqf "the removal of the marker waits in the journal, as a removal" '.paths["_estate/scripts/.runner-test"] == "removed"' "$workspace/.memory-mirror-pending"
stop_fixture
rm -f "$ctl/aws_fail_on"
: > "$ctl/aws_calls.log"
start_fixture test_bucket_retry
queue_one h-test-bucket-retry
export STUB_OPENCODE_MODE=diagnose
run_driver test_bucket_retry
check "the next ordinary job removes the marker from the bucket, once" test "$(grep -cxF "$(argline s3 rm s3://acme-sre-memory/fleet/_estate/scripts/.runner-test --only-show-errors)" "$ctl/aws_calls.log")" -eq 1
check "and the journal is empty again" test ! -e "$workspace/.memory-mirror-pending"
stop_fixture

echo "--- 23c. a restore that has not succeeded fails the bucket step, naming the restore ---"
reset_aws
fresh_workspace
printf -- '--recursive' > "$ctl/aws_fail_on"
start_fixture test_bucket_restore
queue_test_job h-test-bucket-restore ""
export STUB_OPENCODE_MODE=oneline
BUCKET_V="acme-sre-memory"
PREFIX_V=""
run_driver test_bucket_restore
check_jq "the bucket step fails and says the restore has not succeeded" '(.test.steps | map(.ok) == [true, true, true, true, false, true]) and (.test.steps[4].detail | contains("restore"))' "$report"
check "no marker was put into a bucket whose restore is pending" test -z "$(grep -v -- '--recursive' "$ctl/aws_calls.log" || true)"
stop_fixture
rm -f "$ctl/aws_fail_on"
export STUB_OPENCODE_MODE=diagnose


echo "--- 11. the entrypoint refuses a bucket it cannot reach, and runs without one ---"
bash_bin="$(command -v bash)"
# The shebang is absolute: the PATH these run under holds nothing else.
for variant in with without; do
  mkdir -p "$work/ep_$variant"
  for tool in node git gh opencode id; do
    {
      printf '#!%s\n' "$bash_bin"
      cat <<'STUB'
if [ "${0##*/}" = "id" ]; then echo 1000; exit 0; fi
printf '%s\n' "$*" >> "$STUB_LOG"
STUB
    } > "$work/ep_$variant/$tool"
    chmod +x "$work/ep_$variant/$tool"
  done
done
{
  printf '#!%s\n' "$bash_bin"
  echo 'exit 0'
} > "$work/ep_with/aws"
chmod +x "$work/ep_with/aws"
mkdir -p "$work/ep_workspace"
export STUB_LOG="$work/ep.log"
entry() {
  : > "$STUB_LOG"
  rc=0
  out="$(env PATH="$work/ep_$1" SRE_SERVER_URL=https://app.example.invalid SRE_API_KEY=not-a-real-key \
    SRE_MODEL="$model" SRE_WORKSPACE="$work/ep_workspace" "${@:2}" "$bash_bin" "$entrypoint" 2>&1)" || rc=$?
}
entry without SRE_MEMORY_BUCKET=acme-sre-memory
check "a bucket with no aws on PATH refuses to start" test "$rc" -ne 0
check "the refusal names aws" grep -qF 'aws is not on PATH' <<<"$out"
check "the refusal names the variable that needs it" grep -qF 'SRE_MEMORY_BUCKET' <<<"$out"
check "nothing is started when aws is missing" test ! -s "$STUB_LOG"
entry without
check "no bucket and no aws is fine" test "$rc" -eq 0 -a -s "$STUB_LOG"
entry with SRE_MEMORY_BUCKET=acme-sre-memory
check "a bucket with aws on PATH starts" test "$rc" -eq 0 -a -s "$STUB_LOG"

if [ "$fail" -ne 0 ]; then echo "bucket_test: FAILED"; exit 1; fi
echo "bucket_test: all checks passed"
