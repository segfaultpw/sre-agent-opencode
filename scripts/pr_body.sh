#!/usr/bin/env bash
# Prints the body a run's pull request should carry: the body on stdin as it
# is, then whichever of these it lacks, in this order, after a blank line:
#
#   Refs: <CARD_KEY>   the card the request came from, when it came from one
#   <MARKER>           the line that ties the pull request to its request
#   <STAMP>            the package version that produced it
#
# The environment names the three (CARD_KEY and MARKER may be empty). The
# agent's own words are never edited, and a line already there is not repeated:
# the marker and the stamp by a byte for byte match, the card line when the
# LAST `Refs:` line of the body already names the key, since that is the one
# SRE Agent reads off a pull request. The line is read the way the platform
# reads it: on a line of its own, `Refs` in ASCII without regard to case, a
# space or a tab before the key, and a CR before the line end dropped.
set -euo pipefail
export LC_ALL=C

body="$(cat)"
blank=$' \t'
key_pattern='[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}'

tail=""
if [ -n "${CARD_KEY:-}" ]; then
  last="$(printf '%s\n' "$body" | tr -d '\r' | grep -E "^[Rr][Ee][Ff][Ss]:[${blank}]+${key_pattern}[${blank}]*\$" | tail -n 1 || true)"
  last="$(sed -E "s/^[Rr][Ee][Ff][Ss]:[${blank}]+//; s/[${blank}]+\$//" <<<"$last" | tr '[:lower:]' '[:upper:]')"
  if [ "$last" != "$(tr '[:lower:]' '[:upper:]' <<<"$CARD_KEY")" ]; then
    tail="${tail}Refs: ${CARD_KEY}"$'\n'
  fi
fi
if [ -n "${MARKER:-}" ] && [[ "$body" != *"$MARKER"* ]]; then
  tail="${tail}${MARKER}"$'\n'
fi
if [ -n "${STAMP:-}" ] && [[ "$body" != *"$STAMP"* ]]; then
  tail="${tail}${STAMP}"$'\n'
fi

if [ -n "$tail" ]; then
  printf '%s\n\n%s' "$body" "$tail"
else
  printf '%s\n' "$body"
fi
