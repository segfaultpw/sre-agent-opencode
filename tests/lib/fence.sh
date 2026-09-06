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

# fence_resolve <config> <resource> [permission]: prints the action the
# config's rules for that permission give the resource, "ask" when no rule
# matches. The permission defaults to edit, where the resource is a path.
# A bash rule resolves the same way because opencode matches it against the
# whole command string as written, unparsed, so the command is the resource.
fence_resolve() {
  local cfg="$1" path="$2" permission="${3:-edit}" action="ask" pattern value regex
  while IFS=$'\t' read -r pattern value; do
    regex="$(fence_compile "$pattern")"
    if printf '%s' "$path" | grep -qE -- "$regex"; then
      action="$value"
    fi
  done < <(jq -r --arg p "$permission" '.permission[$p] | to_entries[] | "\(.key)\t\(.value)"' "$cfg")
  printf '%s' "$action"
}
