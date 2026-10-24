#!/usr/bin/env bash
# The title a pull request or a commit gets from this package is a Conventional
# Commits header whichever door wrote it. The CI door normalises it in
# scripts/conventional_title.sh (jq, because the workflow runs on the
# customer's runner and already depends on it) and the machine door in
# runner/conventional_title.js (the standard library only). Both are run over
# the one fixture table, so a rule changed in one and not the other fails here.
# SRE Agent's own SreCore.Remediation.ConventionalTitle runs a byte for byte copy
# of the same table in the platform's test suite
# (apps/sre_core/test/fixtures/conventional_titles.json), so a case added here
# is added there too. A case with a `key` is run with that card key, which is
# the only key a title may lose.
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
  key="$(jq -r ".[$index].key // \"\"" "$table")"
  expected="$(jq -j ".[$index].expected" "$table")"
  actual="$(jq -j ".[$index].input" "$table" | CARD_KEY="$key" CONVENTIONAL_TITLE_MAX="$max" bash "$script" "$fallback")"
  if [ "$actual" = "$expected" ]; then
    echo "ok   [jq] $name"
  else
    echo "FAIL [jq] $name"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    fail=1
  fi
  again="$(printf '%s' "$actual" | CARD_KEY="$key" CONVENTIONAL_TITLE_MAX="$max" bash "$script" "$fallback")"
  if [ "$again" != "$actual" ]; then echo "FAIL [jq] $name is not a fixed point: '$again'"; fail=1; fi
done

# No argument means the stock fallback, and nothing on stdin means no text.
if [ "$(printf '' | bash "$script")" = "fix: apply the requested fix" ]; then echo "ok   [jq] empty input takes the stock fallback"; else echo "FAIL [jq] empty input"; fail=1; fi

# A hostile run of tags is not a denial of service.
started="$(date +%s)"
long="$(printf '[a]   %.0s' $(seq 1 20000))x"
if [ "$(printf '%s' "$long" | bash "$script")" = "fix: x" ]; then echo "ok   [jq] a long run of tags is handled"; else echo "FAIL [jq] a long run of tags"; fail=1; fi
if [ $(( $(date +%s) - started )) -lt 20 ]; then echo "ok   [jq] ...in bounded time"; else echo "FAIL [jq] took too long"; fail=1; fi

# A card key read from the environment is the only key a title loses, and one
# that is not key shaped is no key at all.
if [ "$(printf 'NUM-12: widen it' | CARD_KEY=NUM-12 bash "$script")" = "fix: widen it" ]; then echo "ok   [jq] CARD_KEY is read from the environment"; else echo "FAIL [jq] CARD_KEY"; fail=1; fi
if [ "$(printf 'NUM-12: widen it' | bash "$script")" = "fix: NUM-12: widen it" ]; then echo "ok   [jq] no CARD_KEY drops no key"; else echo "FAIL [jq] no CARD_KEY"; fail=1; fi
if [ "$(printf '.*: widen it' | CARD_KEY='.*' bash "$script")" = "fix: .*: widen it" ]; then echo "ok   [jq] a CARD_KEY that is not key shaped is ignored"; else echo "FAIL [jq] a CARD_KEY that is not key shaped"; fail=1; fi

if command -v node >/dev/null 2>&1; then
  if node "$here/conventional_title_test.js"; then :; else fail=1; fi
  # The two doors agree on inputs nobody wrote a case for: a seeded stream of
  # pieces that are hard for one engine or the other (whitespace each defines
  # differently, keys, marks, emoji) through both, compared line by line.
  pairs="$(mktemp)"
  trap 'rm -f "$pairs"' EXIT
  node "$here/conventional_title_test.js" --fuzz 300 > "$pairs"
  mismatches=0
  while IFS= read -r pair; do
    from_js="$(jq -j '.title' <<<"$pair")"
    from_jq="$(jq -j '.input' <<<"$pair" | CARD_KEY=NUM-12 bash "$script")"
    if [ "$from_jq" != "$from_js" ]; then
      mismatches=$((mismatches + 1))
      echo "FAIL [jq vs js] $(jq -c '.input' <<<"$pair")"
      echo "       jq: $(jq -n --arg t "$from_jq" '$t')"
      echo "       js: $(jq -n --arg t "$from_js" '$t')"
    fi
  done < "$pairs"
  if [ "$mismatches" -eq 0 ]; then echo "ok   [jq vs js] 300 generated inputs give the same title"; else fail=1; fi
else
  echo "FAIL node is not on PATH"; fail=1
fi

exit "$fail"
