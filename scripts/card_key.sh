#!/usr/bin/env bash
# Prints the card key a tracking issue is for, or nothing when it has none.
# The marking step writes it into the pull request body as a `Refs: KEY` line.
# Reads ISSUE_TITLE and ISSUE_BODY from the environment: both are text anyone
# who can edit an issue can write, so they never reach a shell as code.
#
#   1. The LAST `Refs: KEY` line of the body, on a line of its own. The platform
#      appends its own after the bounded brief, so whatever a card or a model
#      wrote earlier comes first and loses.
#   2. Otherwise the key at the start of the title, which is where SRE Agent put
#      it before pull requests were titled with Conventional Commits, so this
#      package still marks a pull request for a platform that has not changed.
set -euo pipefail

key_pattern='[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}'

refs="$(printf '%s\n' "${ISSUE_BODY:-}" | tr -d '\r' | grep -iE "^Refs:[[:space:]]+${key_pattern}[[:space:]]*\$" | tail -n 1 || true)"
if [ -n "$refs" ]; then
  sed -E 's/^[Rr][Ee][Ff][Ss]:[[:space:]]+//; s/[[:space:]]+$//' <<<"$refs" | tr '[:lower:]' '[:upper:]'
  exit 0
fi

grep -oE '^[A-Z][A-Z0-9]*-[0-9]+' <<<"${ISSUE_TITLE:-}" | head -n 1 || true
