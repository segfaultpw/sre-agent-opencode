#!/usr/bin/env bash
# The title a pull request or a commit gets from this package is a Conventional
# Commits header whichever door wrote it. The CI door normalises it in
# scripts/conventional_title.sh (jq, because the workflow runs on the
# customer's runner and already depends on it) and the machine door in
# runner/conventional_title.js (the standard library only). Both are run over
# the one fixture table, so a rule changed in one and not the other fails here,
# and both are checked against the platform's own SreCore.Remediation.ConventionalTitle
# by the cases being its cases.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/conventional_title.sh"
table="$here/fixture/conventional_titles.json"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi
if command -v jq >/dev/null 2>&1; then echo "ok   jq is on PATH"; else echo "FAIL jq is not on PATH"; exit 1; fi

count="$(jq 'length' "$table")"
for index in $(seq 0 $((count - 1))); do
  name="$(jq -r ".[$index].name" "$table")"
  max="$(jq -r ".[$index].max // 256" "$table")"
  fallback="$(jq -r ".[$index].fallback // \"apply the requested fix\"" "$table")"
  expected="$(jq -j ".[$index].expected" "$table")"
  actual="$(jq -j ".[$index].input" "$table" | CONVENTIONAL_TITLE_MAX="$max" bash "$script" "$fallback")"
  if [ "$actual" = "$expected" ]; then
    echo "ok   [jq] $name"
  else
    echo "FAIL [jq] $name"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    fail=1
  fi
  again="$(printf '%s' "$actual" | CONVENTIONAL_TITLE_MAX="$max" bash "$script" "$fallback")"
  if [ "$again" != "$actual" ]; then echo "FAIL [jq] $name is not a fixed point: '$again'"; fail=1; fi
done

# No argument means the stock fallback, and nothing on stdin means no text.
if [ "$(printf '' | bash "$script")" = "fix: apply the requested fix" ]; then echo "ok   [jq] empty input takes the stock fallback"; else echo "FAIL [jq] empty input"; fail=1; fi

# A hostile run of tags is not a denial of service.
started="$(date +%s)"
long="$(printf '[a]   %.0s' $(seq 1 20000))x"
if [ "$(printf '%s' "$long" | bash "$script")" = "fix: x" ]; then echo "ok   [jq] a long run of tags is handled"; else echo "FAIL [jq] a long run of tags"; fail=1; fi
if [ $(( $(date +%s) - started )) -lt 20 ]; then echo "ok   [jq] ...in bounded time"; else echo "FAIL [jq] took too long"; fail=1; fi

if command -v node >/dev/null 2>&1; then
  if node "$here/conventional_title_test.js"; then :; else fail=1; fi
else
  echo "FAIL node is not on PATH"; fail=1
fi

exit "$fail"
