#!/usr/bin/env bash
# The run's pull requests are found by branch prefix and creation time, with
# gh replaced by a script that answers from fixtures, so the lookup is pinned
# without a repository: a branch whose pull request predates the run is
# skipped, a branch without one is skipped, the author is logged but never
# used to filter, and a gh failure anywhere in the lookup fails the script,
# since a partial list read as complete would leave a pull request uninspected.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/run_prs.sh"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/fixtures"
export FAKE_GH_DIR="$work/fixtures" FAKE_GH_LOG="$work/gh.log"

cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stands in for gh: records the call, answers the two requests run_prs.sh
# makes, and fails on demand: FAKE_GH_FAIL=api fails the ref listing,
# FAKE_GH_FAIL=prlist fails every pull request listing, and
# FAKE_GH_FAIL=prlist:<branch> fails only that branch's.
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "api repos/acme/app/git/matching-refs/heads/opencode/issue7-")
    if [ "${FAKE_GH_FAIL:-}" = "api" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
    cat "$FAKE_GH_DIR/refs.txt"
    ;;
  "api repos/acme/app/git/matching-refs/heads/opencode/dispatch-")
    if [ "${FAKE_GH_FAIL:-}" = "api" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
    cat "$FAKE_GH_DIR/dispatch-refs.txt"
    ;;
  "pr list")
    head=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--head" ]; then head="$2"; fi
      shift
    done
    if [ "${FAKE_GH_FAIL:-}" = "prlist" ] || [ "${FAKE_GH_FAIL:-}" = "prlist:${head}" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
    file="$FAKE_GH_DIR/prs-${head//\//_}.json"
    if [ -f "$file" ]; then cat "$file"; else echo "[]"; fi
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 9
    ;;
esac
EOF
chmod +x "$work/bin/gh"

printf '%s\n' \
  refs/heads/opencode/issue7-20260905T220000 \
  refs/heads/opencode/issue7-20260905T230000 \
  refs/heads/opencode/issue7-20260905T235900 \
  > "$work/fixtures/refs.txt"
cat > "$work/fixtures/prs-opencode_issue7-20260905T220000.json" <<'EOF'
[{"number": 41, "title": "Older", "body": "from an earlier run", "isDraft": false, "createdAt": "2026-09-05T22:00:30Z", "author": {"login": "app/opencode-agent"}, "headRefName": "opencode/issue7-20260905T220000"}]
EOF
cat > "$work/fixtures/prs-opencode_issue7-20260905T230000.json" <<'EOF'
[{"number": 42, "title": "Fix the thing", "body": "what changed", "isDraft": false, "createdAt": "2026-09-05T23:00:45Z", "author": {"login": "app/opencode-agent"}, "headRefName": "opencode/issue7-20260905T230000"}]
EOF

export PATH="$work/bin:$PATH"
export GITHUB_REPOSITORY=acme/app ISSUE_NUMBER=7 SRE_AGENT_RUN_STARTED=2026-09-05T22:59:00Z

out="$(bash "$script" 2> "$work/stderr")"
if [ "$(wc -l <<<"$out")" -eq 1 ] && [ "$(jq -r '.number' <<<"$out")" = "42" ]; then echo "ok   only the pull request created after the run started is returned"; else echo "FAIL output: $out"; fail=1; fi
if jq -e '.title == "Fix the thing" and .isDraft == false and .headRefName == "opencode/issue7-20260905T230000"' <<<"$out" >/dev/null; then echo "ok   the pull request's fields are passed through"; else echo "FAIL fields: $out"; fail=1; fi
if grep -q 'pull request #42 .* by app/opencode-agent' "$work/stderr"; then echo "ok   the author is logged"; else echo "FAIL author log: $(cat "$work/stderr")"; fail=1; fi
if grep -q 'api repos/acme/app/git/matching-refs/heads/opencode/issue7- --paginate' "$work/gh.log"; then echo "ok   branches are listed by prefix with pagination"; else echo "FAIL matching-refs call: $(cat "$work/gh.log")"; fail=1; fi
if [ "$(grep -c '^pr list --repo acme/app --state open --head opencode/issue7-' "$work/gh.log")" -eq 3 ]; then echo "ok   every branch is looked up by head"; else echo "FAIL pr list calls: $(cat "$work/gh.log")"; fail=1; fi

rc=0
out="$(env -u ISSUE_NUMBER bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a missing issue number is refused"; else echo "FAIL a missing issue number was accepted"; fail=1; fi

rc=0
out="$(FAKE_GH_FAIL=api bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a failed ref listing fails the script"; else echo "FAIL a failed ref listing exited 0 with: $out"; fail=1; fi

rc=0
out="$(FAKE_GH_FAIL=prlist bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a failed pull request listing fails the script"; else echo "FAIL a failed pull request listing exited 0 with: $out"; fail=1; fi

# The first branch answers, the second fails: a line may have been printed,
# but the status must say the list is not complete.
rc=0
out="$(FAKE_GH_FAIL=prlist:opencode/issue7-20260905T230000 bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a failure on the second branch fails the script"; else echo "FAIL a failure on the second branch exited 0 with: $out"; fail=1; fi

: > "$work/fixtures/refs.txt"
out="$(bash "$script" 2>/dev/null)"
if [ -z "$out" ]; then echo "ok   no branches means no pull requests"; else echo "FAIL expected no output, got: $out"; fail=1; fi

# A run the relay dispatched carries no issue in its event, and the action
# names its branch opencode/dispatch-<hex>-<timestamp>, with no issue number
# in it. Two runs of one repository therefore see each other's branches, and
# the "mine" field is what tells them apart: the action ends every body it
# opens with a link to its own run. Both are reported, because the diff gate
# has to inspect a protected-path pull request whichever run opened it and
# only the verdict belongs to the run that opened it.
cat > "$work/fixtures/dispatch-refs.txt" <<'EOF'
refs/heads/opencode/dispatch-a1b2c3-20260909T101500
refs/heads/opencode/dispatch-d4e5f6-20260909T101600
refs/heads/opencode/dispatch-99aabb-20260909T101700
EOF
cat > "$work/fixtures/prs-opencode_dispatch-a1b2c3-20260909T101500.json" <<'EOF'
[{"number": 51, "title": "This run", "body": "what changed\n\n[github run](/acme/app/actions/runs/555)", "isDraft": false, "createdAt": "2026-09-09T10:16:00Z", "author": {"login": "app/opencode-agent"}, "headRefName": "opencode/dispatch-a1b2c3-20260909T101500"}]
EOF
cat > "$work/fixtures/prs-opencode_dispatch-d4e5f6-20260909T101600.json" <<'EOF'
[{"number": 52, "title": "Another run", "body": "what changed\n\n[github run](/acme/app/actions/runs/999)", "isDraft": false, "createdAt": "2026-09-09T10:17:00Z", "author": {"login": "app/opencode-agent"}, "headRefName": "opencode/dispatch-d4e5f6-20260909T101600"}]
EOF
# A run whose id merely starts with this run's, which a match on the link
# without its closing parenthesis would have claimed.
cat > "$work/fixtures/prs-opencode_dispatch-99aabb-20260909T101700.json" <<'EOF'
[{"number": 53, "title": "A longer run id", "body": "what changed\n\n[github run](/acme/app/actions/runs/5551)", "isDraft": false, "createdAt": "2026-09-09T10:18:00Z", "author": {"login": "app/opencode-agent"}, "headRefName": "opencode/dispatch-99aabb-20260909T101700"}]
EOF

dispatched=(env GITHUB_EVENT_NAME=workflow_dispatch GITHUB_RUN_ID=555)

out="$("${dispatched[@]}" bash "$script" 2>"$work/stderr")"
if [ "$(grep -c . <<<"$out")" -eq 3 ]; then echo "ok   every dispatch branch of the window is reported"; else echo "FAIL dispatch output: $out"; fail=1; fi
if [ "$(jq -r 'select(.number == 51) | .mine' <<<"$out")" = "true" ]; then echo "ok   the pull request whose body links this run is this run's"; else echo "FAIL 51 mine: $out"; fail=1; fi
if [ "$(jq -r 'select(.number == 52) | .mine' <<<"$out")" = "false" ]; then echo "ok   the pull request linking another run is not this run's"; else echo "FAIL 52 mine: $out"; fail=1; fi
if [ "$(jq -r 'select(.number == 53) | .mine' <<<"$out")" = "false" ]; then echo "ok   a run id this one is only a prefix of is another run"; else echo "FAIL 53 mine: $out"; fail=1; fi
if grep -q 'pull request #52 .*links another run' "$work/stderr"; then echo "ok   another run's pull request is named rather than passed over in silence"; else echo "FAIL stderr: $(cat "$work/stderr")"; fail=1; fi

rc=0
env GITHUB_EVENT_NAME=workflow_dispatch bash "$script" >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a dispatched run without a run id is refused rather than claiming everything"; else echo "FAIL ran without GITHUB_RUN_ID"; fail=1; fi

# The comment door is untouched: its branch carries the issue number, one run
# per issue is all the concurrency group allows, and every candidate is this
# run's own.
printf '%s\n' refs/heads/opencode/issue7-20260905T230000 > "$work/fixtures/refs.txt"
out="$(env GITHUB_EVENT_NAME=issue_comment bash "$script" 2>/dev/null)"
if [ "$(jq -r '.number' <<<"$out")" = "42" ] && [ "$(jq -r '.mine' <<<"$out")" = "true" ]; then echo "ok   a comment-started run's candidate is its own"; else echo "FAIL comment door output: $out"; fail=1; fi

rc=0
bash "$script" --mine >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then echo "ok   an argument is refused, since the caller filters on the field"; else echo "FAIL argument exit $rc"; fail=1; fi

exit $fail
