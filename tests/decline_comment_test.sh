#!/usr/bin/env bash
# A run that opens no pull request ends in a comment beginning "Declined:",
# and SRE Agent ends the remediation row that comment's marker names, so the
# marker has to reach the comment. gh is replaced by a script that answers
# from fixtures and records every call, which pins the whole contract without
# a repository: the newest decline this run's clock covers is the one edited,
# its new body carries the marker line and the version stamp, an issue body
# without a marker leaves the comment untouched, a comment that already
# carries both is not edited again, and a failed listing fails the script
# rather than reading as "nothing was declined".
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/decline_comment.sh"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/fixtures"
export FAKE_GH_DIR="$work/fixtures" FAKE_GH_LOG="$work/gh.log"

cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stands in for gh: records the call, answers the comment listing from a
# fixture, writes a PATCH's request body to patched.json, and fails the
# listing on demand with FAKE_GH_FAIL=comments.
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" != "api" ]; then echo "unexpected gh call: $*" >&2; exit 9; fi
shift
method=GET
endpoint=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    --input) shift 2 ;;
    --paginate) shift ;;
    *) endpoint="$1"; shift ;;
  esac
done
case "$method $endpoint" in
  "GET repos/acme/app/issues/7/comments?per_page=100")
    if [ "${FAKE_GH_FAIL:-}" = "comments" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
    cat "$FAKE_GH_DIR/comments.json"
    ;;
  "PATCH repos/acme/app/issues/comments/"*)
    cat > "$FAKE_GH_DIR/patched.json"
    printf '%s\n' "{\"id\": ${endpoint##*/}}"
    ;;
  *)
    echo "unexpected gh call: $method $endpoint" >&2
    exit 9
    ;;
esac
EOF
chmod +x "$work/bin/gh"

export PATH="$work/bin:$PATH"
export GITHUB_REPOSITORY=acme/app ISSUE_NUMBER=7 SRE_AGENT_RUN_STARTED=2026-09-05T22:59:00Z
export SRE_AGENT_OPENCODE_VERSION=v1.1.0
marker='<!-- sre-agent:remediation:8f3c1a2b -->'
stamp='<!-- sre-agent-opencode:v1.1.0 -->'
export ISSUE_BODY="Alert: the queue is backed up.

${marker}"

# One page of comments: a decline from an earlier run, a comment that is not
# a decline, and this run's decline. GitHub returns them oldest first.
write_comments() {
  jq -n --arg this "$1" '[
    {"id": 9001, "created_at": "2026-09-05T22:10:00Z", "body": "Declined: an earlier run found nothing to change."},
    {"id": 9002, "created_at": "2026-09-05T23:00:10Z", "body": "Created PR #12"},
    {"id": 9003, "created_at": "2026-09-05T23:01:00Z", "body": $this}
  ]' > "$FAKE_GH_DIR/comments.json"
}

decline='Declined: the failing test needs a schema change the brief does not cover.

Sent by opencode.'
write_comments "$decline"

out="$(bash "$script" 2> "$work/stderr")"
if [ -f "$FAKE_GH_DIR/patched.json" ]; then echo "ok   the decline comment is edited"; else echo "FAIL nothing was edited: $out $(cat "$work/stderr")"; fail=1; fi
if grep -q 'PATCH repos/acme/app/issues/comments/9003' "$work/gh.log"; then echo "ok   the newest decline this run covers is the one edited"; else echo "FAIL patched the wrong comment: $(cat "$work/gh.log")"; fail=1; fi

body="$(jq -r '.body' "$FAKE_GH_DIR/patched.json")"
if [[ "$body" == "$decline"* ]]; then echo "ok   the comment keeps the text the action posted"; else echo "FAIL the original text is gone: $body"; fail=1; fi
if [ "$(printf '%s\n' "$body" | tail -n 2 | head -n 1)" = "$marker" ]; then echo "ok   the marker is on its own line"; else echo "FAIL marker line: $body"; fail=1; fi
if [ "$(printf '%s\n' "$body" | tail -n 1)" = "$stamp" ]; then echo "ok   the version stamp ends the comment"; else echo "FAIL stamp line: $body"; fail=1; fi

# The marker is what the platform ends a row by, so an issue that carries
# none leaves the customer's comment exactly as the action wrote it.
rm -f "$FAKE_GH_DIR/patched.json"
: > "$work/gh.log"
out="$(ISSUE_BODY="Alert: the queue is backed up." bash "$script")"
if [ ! -f "$FAKE_GH_DIR/patched.json" ] && ! grep -q PATCH "$work/gh.log"; then echo "ok   an issue body without a marker edits nothing"; else echo "FAIL edited without a marker: $(cat "$work/gh.log")"; fail=1; fi
if [[ "$out" == *"no marker line in the issue body"* ]]; then echo "ok   the run says why nothing was edited"; else echo "FAIL output: $out"; fail=1; fi

# The agent is told to end its message with both lines, so the usual case is
# a comment that already carries them and needs no edit at all.
rm -f "$FAKE_GH_DIR/patched.json"
: > "$work/gh.log"
write_comments "Declined: nothing to change.

${marker}
${stamp}"
out="$(bash "$script")"
if [ ! -f "$FAKE_GH_DIR/patched.json" ]; then echo "ok   a comment that already carries both is not edited"; else echo "FAIL edited a comment that needed nothing"; fail=1; fi

# The agent copied the marker but not the stamp: only the stamp is added.
rm -f "$FAKE_GH_DIR/patched.json"
write_comments "Declined: nothing to change.

${marker}"
bash "$script" >/dev/null
body="$(jq -r '.body' "$FAKE_GH_DIR/patched.json")"
if [ "$(grep -cF "$marker" <<<"$body")" -eq 1 ] && [ "$(grep -cF "$stamp" <<<"$body")" -eq 1 ]; then echo "ok   a marker already in the comment is not repeated"; else echo "FAIL duplicate lines: $body"; fail=1; fi

# A decline that predates this run belongs to another request.
rm -f "$FAKE_GH_DIR/patched.json"
jq -n '[{"id": 9001, "created_at": "2026-09-05T22:10:00Z", "body": "Declined: an earlier run found nothing to change."}]' > "$FAKE_GH_DIR/comments.json"
out="$(bash "$script")"
if [ ! -f "$FAKE_GH_DIR/patched.json" ]; then echo "ok   a decline from before the run started is left alone"; else echo "FAIL edited an older decline"; fail=1; fi
if [[ "$out" == *"no Declined: comment"* ]]; then echo "ok   the run says no decline was found"; else echo "FAIL output: $out"; fail=1; fi

# A pull request run comments too, and that comment is not a decline.
rm -f "$FAKE_GH_DIR/patched.json"
jq -n '[{"id": 9002, "created_at": "2026-09-05T23:00:10Z", "body": "Created PR #12"}]' > "$FAKE_GH_DIR/comments.json"
bash "$script" >/dev/null
if [ ! -f "$FAKE_GH_DIR/patched.json" ]; then echo "ok   a comment that is not a decline is left alone"; else echo "FAIL edited a comment that is not a decline"; fail=1; fi

write_comments "$decline"
rc=0
out="$(FAKE_GH_FAIL=comments bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a failed comment listing fails the script"; else echo "FAIL a failed listing exited 0 with: $out"; fail=1; fi

rc=0
out="$(env -u SRE_AGENT_OPENCODE_VERSION bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a missing version stamp is refused"; else echo "FAIL a missing version was accepted"; fail=1; fi

rc=0
out="$(env -u ISSUE_NUMBER bash "$script" 2>/dev/null)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a missing issue number is refused"; else echo "FAIL a missing issue number was accepted"; fail=1; fi

exit $fail
