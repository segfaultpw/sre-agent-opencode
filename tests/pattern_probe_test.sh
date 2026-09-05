#!/usr/bin/env bash
# Resolves probe paths against the config's edit rules the way opencode does,
# so a pattern that looks right but never fires is caught here rather than in
# a customer's pull request. The translation is the one in opencode's
# packages/core/src/util/wildcard.ts: regex metacharacters escaped, "*" to
# ".*", "?" to ".", a trailing " *" to "( .*)?", the whole thing anchored, and
# "/" left literal. The resource an edit is judged by is the path relative to
# the checkout, and the last matching rule wins, in the object's file order.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$here/../config/opencode.json"
fail=0

compile() {
  local pattern="${1//\\//}" escaped="" c i
  for ((i = 0; i < ${#pattern}; i++)); do
    c="${pattern:i:1}"
    case "$c" in
      '*') escaped+='.*' ;;
      '?') escaped+='.' ;;
      '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | "\\") escaped+="\\$c" ;;
      *) escaped+="$c" ;;
    esac
  done
  if [[ "$escaped" == *" .*" ]]; then
    escaped="${escaped% .*}( .*)?"
  fi
  printf '^%s$' "$escaped"
}

resolve() {
  local path="$1" action="ask" pattern value regex
  while IFS=$'\t' read -r pattern value; do
    regex="$(compile "$pattern")"
    if printf '%s' "$path" | grep -qE -- "$regex"; then
      action="$value"
    fi
  done < <(jq -r '.permission.edit | to_entries[] | "\(.key)\t\(.value)"' "$cfg")
  printf '%s' "$action"
}

probe() {
  local path="$1" want="$2" got
  got="$(resolve "$path")"
  if [ "$got" = "$want" ]; then echo "ok   edit $path -> $want"; else echo "FAIL edit $path: expected $want, got $got"; fail=1; fi
}

# The translation itself, pinned on the shapes the fences rely on.
check_regex() {
  local pattern="$1" want="$2" got
  got="$(compile "$pattern")"
  if [ "$got" = "$want" ]; then echo "ok   $pattern compiles to $want"; else echo "FAIL $pattern compiled to $got, expected $want"; fail=1; fi
}
check_regex '*.env*' '^.*\.env.*$'
check_regex '.github/**' '^\.github/.*.*$'
check_regex '**/*.pem' '^.*.*/.*\.pem$'
check_regex 'curl *' '^curl( .*)?$'
check_regex 'a?b' '^a.b$'

probe .env deny
probe src/.env deny
probe .env.production deny
probe secrets.yml deny
probe config/secrets/x deny
probe key.pem deny
probe a/b/key.pem deny
probe .github/workflows/ci.yml deny
probe src/app.ex allow

exit $fail
