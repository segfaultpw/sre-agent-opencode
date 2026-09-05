#!/usr/bin/env bash
# Sourced by the tests that need opencode's own judgement of a path. The
# translation is the one in opencode's packages/core/src/util/wildcard.ts:
# regex metacharacters escaped, "*" to ".*", "?" to ".", a trailing " *" to
# "( .*)?", the whole thing anchored, and "/" left literal. The resource an
# edit is judged by is the path relative to the checkout, and the last
# matching rule wins, in the object's file order. Re-read wildcard.ts on any
# opencode bump; the dry run reads the resolved rules out of the real binary,
# so a change that mattered would surface there as well.

fence_compile() {
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

# fence_resolve <config> <path>: prints the action the config's edit rules
# give the path, "ask" when no rule matches.
fence_resolve() {
  local cfg="$1" path="$2" action="ask" pattern value regex
  while IFS=$'\t' read -r pattern value; do
    regex="$(fence_compile "$pattern")"
    if printf '%s' "$path" | grep -qE -- "$regex"; then
      action="$value"
    fi
  done < <(jq -r '.permission.edit | to_entries[] | "\(.key)\t\(.value)"' "$cfg")
  printf '%s' "$action"
}
