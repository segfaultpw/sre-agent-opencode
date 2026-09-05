#!/usr/bin/env bash
# The run's pull requests are found by branch prefix and creation time, with
# gh replaced by a script that answers from fixtures, so the lookup is pinned
# without a repository: a branch whose pull request predates the run is
# skipped, a branch without one is skipped, and the author is logged but
# never used to filter.
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
# Stands in for gh: records the call, answers the two requests run_prs.sh makes.
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "api repos/acme/app/git/matching-refs/heads/opencode/issue7-")
    cat "$FAKE_GH_DIR/refs.txt"
    ;;
  "pr list")
    head=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--head" ]; then head="$2"; fi
      shift
    done
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

: > "$work/fixtures/refs.txt"
out="$(bash "$script" 2>/dev/null)"
if [ -z "$out" ]; then echo "ok   no branches means no pull requests"; else echo "FAIL expected no output, got: $out"; fail=1; fi

exit $fail
