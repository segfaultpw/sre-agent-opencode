#!/usr/bin/env bash
# Prints the card key a tracking issue is for, or nothing when it has none.
# The marking step writes it into the pull request body as a `Refs: KEY` line
# and passes it to conventional_title.sh as the one key a title may lose.
# Reads ISSUE_TITLE and ISSUE_BODY from the environment: both are text anyone
# who can edit an issue can write, so they never reach a shell as code.
#
#   1. The `Refs: KEY` line of the copy block SRE Agent ends the body with: the
#      line directly before the marker line, the marker line being the last
#      line that is not blank. Nothing a card, a requester or a model wrote
#      can stand there, because the platform appends the block after their
#      text and spells out any marker of theirs. A `Refs:` line anywhere else
#      is their words and names no card.
#   2. Otherwise `KEY:` at the start of the title, which is where SRE Agent put
#      the key before pull requests were titled with Conventional Commits, so
#      this package still marks a pull request for a platform that has not
#      changed.
#
# Lines end at LF; a CR before it is dropped. A space or a tab separates
# `Refs:` from the key, and `Refs` is matched in ASCII without regard to case,
# the way the platform reads the same line.
set -euo pipefail
export LC_ALL=C

blank=$' \t'
key_pattern='[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}'
refs_pattern="^[Rr][Ee][Ff][Ss]:[${blank}]+(${key_pattern})[${blank}]*\$"
marker_pattern="^<!-- sre-agent:remediation:[^>]*-->[${blank}]*\$"
blank_line="^[${blank}]*\$"

lines=()
while IFS= read -r line || [ -n "$line" ]; do
  lines+=("${line%$'\r'}")
done <<<"${ISSUE_BODY:-}"

last=$((${#lines[@]} - 1))
while [ "$last" -ge 0 ] && [[ "${lines[$last]}" =~ $blank_line ]]; do
  last=$((last - 1))
done

if [ "$last" -ge 1 ] && [[ "${lines[$last]}" =~ $marker_pattern ]] && [[ "${lines[$((last - 1))]}" =~ $refs_pattern ]]; then
  printf '%s\n' "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]'
  exit 0
fi

if [[ "${ISSUE_TITLE:-}" =~ ^([A-Z][A-Z0-9]{1,5}-[1-9][0-9]{0,8}): ]]; then
  printf '%s\n' "${BASH_REMATCH[1]}"
fi
