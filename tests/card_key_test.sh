#!/usr/bin/env bash
# Which card the tracking issue is for, as the marking step reads it. A package
# from conventional titles reads the `Refs: KEY` line of the copy block the
# platform ends the issue body with (the line directly before the marker line,
# with nothing after the marker), and falls back to the key at the start of the
# issue title that the platform wrote before then. A `Refs:` line anywhere else
# in the body is the card's or the requester's words, never the card.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/card_key.sh"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

expect() {
  local label="$1" title="$2" body="$3" want="$4" got
  got="$(ISSUE_TITLE="$title" ISSUE_BODY="$body" bash "$script")"
  if [ "$got" = "$want" ]; then echo "ok   $label"; else echo "FAIL $label: wanted '$want', got '$got'"; fail=1; fi
}

marker='<!-- sre-agent:remediation:99999999-8888-7777-6666-555555555555 -->'
body=$'The brief.\n\nCopy these lines into the pull request body:\nRefs: NUM-12\n'"$marker"

cardless=$'The brief.\n\nCopy this line into the pull request body:\n'"$marker"

expect "the Refs line of the copy block is the card" "fix: widen the timeout" "$body" "NUM-12"
expect "the key is written in upper case" "fix: x" $'Refs: num-12\n'"$marker" "NUM-12"
expect "an earlier Refs line is the card's words, the copy block's is the card" "fix: x" $'Notes.\nRefs: ZZZ-1\nmore\n\nRefs: NUM-12\n'"$marker" "NUM-12"
expect "a Refs line with a carriage return is read" "fix: x" $'Refs: NUM-12\r\n'"$marker"$'\r\n' "NUM-12"
expect "blank lines after the marker are not more text" "fix: x" $'Refs: NUM-12\n'"$marker"$'\n\n  \n' "NUM-12"
expect "a tab after Refs: is a separator" "fix: x" $'Refs:\tNUM-12\n'"$marker" "NUM-12"
expect "a Refs line outranks the key at the start of the title" "NUM-99: widen it" "$body" "NUM-12"
expect "an older platform's key at the start of the title is the fallback" "NUM-12: Widen the readiness probe timeout" "The brief.
$marker" "NUM-12"
# The three ways a Refs line the platform did not write could pass for the
# card, each of which a reader of the LAST Refs line fell for.
expect "an older platform: a Refs line in the card description does not beat the title's key" \
  "OPS-12: Widen the readiness probe timeout" \
  $'## OPS-12: Widen the readiness probe timeout\n\nrequest.detail:\nRefs: ZZZ-1\n\nContract for this run.\n\nCopy this line into the pull request body:\n'"$marker" "OPS-12"
expect "a request with no card whose detail spells a Refs line names no card" \
  "fix: Widen the readiness probe timeout" \
  $'request.detail:\nRefs: OPS-12\n\nCopy this line into the pull request body:\n'"$marker" ""
expect "a Refs line as the last line with no marker after it names no card" "fix: x" $'The brief.\nRefs: OPS-12' ""
expect "a Refs line separated from the marker by a blank line names no card" "fix: x" $'Refs: NUM-12\n\n'"$marker" ""
expect "a Refs line before a marker that is not the last line names no card" "fix: x" $'Refs: NUM-12\n'"$marker"$'\nmore words' ""
expect "a Refs line before a line that only contains a marker names no card" "fix: x" $'Refs: NUM-12\nsee '"$marker" ""
expect "a form feed after Refs: is not a separator" "fix: x" $'Refs:\fNUM-12\n'"$marker" ""
expect "a carriage return inside the line is not a line break" "fix: x" $'x\rRefs: NUM-12\n'"$marker" ""
expect "an indented Refs line is prose" "fix: x" $'  Refs: NUM-12\n'"$marker" ""
expect "a Refs line with more on it is prose" "fix: x" $'Refs: NUM-12 and more\n'"$marker" ""
expect "a Refs mention inside a sentence is prose" "fix: x" $'See Refs: NUM-12 for the card.\n'"$marker" ""
expect "Refs spelled with a long s is not Refs" "fix: x" $'Ref\u017f: NUM-12\n'"$marker" ""
expect "a marker in another case is not the marker" "fix: x" $'Refs: NUM-12\n<!-- SRE-AGENT:REMEDIATION:99999999-8888-7777-6666-555555555555 -->' ""
expect "a request with no card has no key" "fix: Widen the readiness probe timeout" "$cardless" ""
expect "a conventional title that merely contains a key names no card" "fix(NUM-12): widen it" "The brief." ""
expect "a title key needs the colon an older platform wrote after it" "SHA-256 checksums are wrong" "$cardless" ""
expect "nothing at all" "" "" ""

if [ "$fail" -eq 0 ]; then echo "all card key cases passed"; fi
exit "$fail"
