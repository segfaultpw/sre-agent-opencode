#!/usr/bin/env bash
# Which card the tracking issue is for, as the marking step reads it. A package
# from conventional titles reads the last `Refs: KEY` line of the issue body,
# which the platform appends after everything a card or a model said, and falls
# back to the key at the start of the issue title that the platform wrote
# before then, so a newer package still marks a pull request for an older
# platform and the reverse.
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

expect "the Refs line of the body is the card" "fix: widen the timeout" "$body" "NUM-12"
expect "the key is written in upper case" "fix: x" $'Refs: num-12\n'"$marker" "NUM-12"
expect "the last Refs line wins, because the platform appends its own last" "fix: x" $'Notes.\nRefs: ZZZ-1\nmore\n\nRefs: NUM-12\n'"$marker" "NUM-12"
expect "a Refs line with a carriage return is read" "fix: x" $'Refs: NUM-12\r\n'"$marker" "NUM-12"
expect "a Refs line outranks the key at the start of the title" "NUM-99: widen it" "$body" "NUM-12"
expect "an older platform's key at the start of the title is the fallback" "NUM-12: Widen the readiness probe timeout" "The brief.
$marker" "NUM-12"
expect "an indented Refs line is prose" "fix: x" $'  Refs: NUM-12\n'"$marker" ""
expect "a Refs line with more on it is prose" "fix: x" $'Refs: NUM-12 and more\n'"$marker" ""
expect "a Refs mention inside a sentence is prose" "fix: x" $'See Refs: NUM-12 for the card.\n'"$marker" ""
expect "a request with no card has no key" "fix: Widen the readiness probe timeout" "The brief.
$marker" ""
expect "a conventional title that merely contains a key names no card" "fix(NUM-12): widen it" "The brief." ""
expect "nothing at all" "" "" ""

if [ "$fail" -eq 0 ]; then echo "all card key cases passed"; fi
exit "$fail"
