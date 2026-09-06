#!/usr/bin/env bash
# Sourced by the tests that need opencode's own judgement. Everything here
# follows the installed binary, read out of the bundle it ships:
#
#   Wildcard.match(resource, pattern): both sides get "\" replaced by "/",
#   the pattern escapes [.+^${}()|[]\], "*" becomes ".*", "?" becomes ".",
#   a trailing " .*" becomes "( .*)?", and the result is anchored and
#   compiled with the "s" flag, so "." crosses a newline.
#
#   Permission.evaluate: findLast over the ruleset ARRAY, which
#   Permission.fromConfig builds from the config object in key order. The
#   last matching rule in file order wins, and the default is ask.
#
#   ShellTool.collect: a command line is PARSED, not taken as one string. It
#   walks descendantsOfType("command") and adds one resource per command
#   node, each being that node's own text, or its redirected_statement
#   parent's text. Permission.ask then evaluates every resource and denies
#   the call as soon as one of them resolves to deny.
#
# Re-read those on any opencode bump. tests/dry_run_test.sh witnesses the
# resolved ruleset and the parsing through the real binary.

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

# fence_resolve <config> <resource> [permission]: the action the config's
# rules for that permission give ONE resource, "ask" when none matches. The
# permission defaults to edit, where the resource is a path relative to the
# checkout. A bash resource is one command node's text, so a whole command
# line goes through fence_resolve_bash instead.
fence_resolve() {
  local cfg="$1" path="${2//\\//}" permission="${3:-edit}" action="ask" pattern value regex
  while IFS=$'\t' read -r pattern value; do
    regex="$(fence_compile "$pattern")"
    # bash compiles a regex without REG_NEWLINE, so "." matches a newline and
    # the anchors bind to the ends of the whole string, which is what the
    # JavaScript "s" flag with "^" and "$" does. This was grep, which is line
    # oriented and therefore answered on a line rather than on the resource.
    if [[ "$path" =~ $regex ]]; then
      action="$value"
    fi
  done < <(jq -r --arg p "$permission" '.permission[$p] | to_entries[] | "\(.key)\t\(.value)"' "$cfg")
  printf '%s' "$action"
}

# fence_resolve_bash <config> <command line>: the action opencode gives a
# whole command line, by resolving every command in it and taking deny if any
# one denies, then ask, then allow.
#
# The split is an approximation of the tree-sitter parse, and the two places
# it can disagree with the binary are worth knowing:
#
#   1. It splits on &&, ||, ;, |, a newline, $( ) and a backtick wherever
#      they appear, including inside a quoted string, where the parser keeps
#      them in one command. That can only add resources, so it can turn an
#      allow into a deny, never the reverse.
#   2. The binary's resource for a command that CONTAINS a substitution is
#      the node's whole text, substitution included, while this model strips
#      the substitution into its own segment. So a rule written with a
#      leading wildcard can be matched in the binary by text sitting inside a
#      substitution, and this model will not see it. That is why the read
#      re-allows for kubectl and terraform are anchored: an anchored allow
#      cannot be reached that way, so the model and the binary agree.
fence_resolve_bash() {
  local cfg="$1" line="$2" verdict="allow" split part action
  split="${line//&&/$'\n'}"
  split="${split//||/$'\n'}"
  split="${split//;/$'\n'}"
  split="${split//|/$'\n'}"
  split="${split//\$(/$'\n'}"
  split="${split//\`/$'\n'}"
  split="${split//)/$'\n'}"
  while IFS= read -r part; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [ -z "$part" ] && continue
    action="$(fence_resolve "$cfg" "$part" bash)"
    case "$action" in
      deny)
        printf 'deny'
        return
        ;;
      ask) verdict="ask" ;;
    esac
  done <<<"$split"
  printf '%s' "$verdict"
}
