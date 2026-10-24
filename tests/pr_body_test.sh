#!/usr/bin/env bash
# The body the marking step leaves on the run's pull request: the agent's own
# words untouched, then whatever of the card line, the marker line and the
# version stamp is missing, in that order and nothing twice. The marker and the
# stamp are byte for byte what the platform and the workflow wrote.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/pr_body.sh"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

marker='<!-- sre-agent:remediation:99999999-8888-7777-6666-555555555555 -->'
stamp='<!-- sre-agent-opencode:v1.4.0 -->'

body_for() { # body key marker stamp
  printf '%s' "$1" | CARD_KEY="$2" MARKER="$3" STAMP="$4" bash "$script"
}

expect() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "ok   $label"; else echo "FAIL $label"; echo "       wanted: $(printf '%q' "$want")"; echo "       got:    $(printf '%q' "$got")"; fail=1; fi
}

agent=$'Raised the pool ceiling and ran the suite.'

expect "a bare body gets the card line, the marker and the stamp, in that order" \
  "$(body_for "$agent" NUM-12 "$marker" "$stamp")" \
  "$agent"$'\n\nRefs: NUM-12\n'"$marker"$'\n'"$stamp"

expect "a request with no card gets no Refs line" \
  "$(body_for "$agent" "" "$marker" "$stamp")" \
  "$agent"$'\n\n'"$marker"$'\n'"$stamp"

expect "a body that has all three is left as it is" \
  "$(body_for "$agent"$'\n\nRefs: NUM-12\n'"$marker"$'\n'"$stamp" NUM-12 "$marker" "$stamp")" \
  "$agent"$'\n\nRefs: NUM-12\n'"$marker"$'\n'"$stamp"

expect "the agent's own marker and stamp are not repeated, and only the card line is added" \
  "$(body_for "$agent"$'\n\n'"$marker"$'\n'"$stamp" NUM-12 "$marker" "$stamp")" \
  "$agent"$'\n\n'"$marker"$'\n'"$stamp"$'\n\nRefs: NUM-12'

expect "a Refs line naming another card is not the card line, so ours is added after it" \
  "$(body_for "$agent"$'\n\nRefs: ZZZ-1\n'"$marker"$'\n'"$stamp" NUM-12 "$marker" "$stamp")" \
  "$agent"$'\n\nRefs: ZZZ-1\n'"$marker"$'\n'"$stamp"$'\n\nRefs: NUM-12'

expect "the card line is matched in either case" \
  "$(body_for "$agent"$'\n\nrefs: num-12\n'"$marker"$'\n'"$stamp" NUM-12 "$marker" "$stamp")" \
  "$agent"$'\n\nrefs: num-12\n'"$marker"$'\n'"$stamp"

expect "an earlier Refs line for another card does not hide ours" \
  "$(body_for $'Refs: ZZZ-1\n\n'"$agent"$'\nRefs: NUM-12\n'"$marker"$'\n'"$stamp" NUM-12 "$marker" "$stamp")" \
  $'Refs: ZZZ-1\n\n'"$agent"$'\nRefs: NUM-12\n'"$marker"$'\n'"$stamp"

expect "a missing marker is added and a missing issue marker adds nothing" \
  "$(body_for "$agent" "" "" "$stamp")" \
  "$agent"$'\n\n'"$stamp"

expect "an empty body gets the lines alone" \
  "$(body_for "" NUM-12 "$marker" "$stamp")" \
  $'\n\nRefs: NUM-12\n'"$marker"$'\n'"$stamp"

if [ "$fail" -eq 0 ]; then echo "all pull request body cases passed"; fi
exit "$fail"
