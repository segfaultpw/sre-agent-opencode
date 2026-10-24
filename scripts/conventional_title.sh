#!/usr/bin/env bash
# Reads text on stdin and prints it as one Conventional Commits header,
# `type(scope)!: subject`, the way SRE Agent's own pull requests are titled.
# The CI workflow runs it over the title the opencode action gave the pull
# request; runner/conventional_title.js is the same rules for the machine
# door, and tests/conventional_title_test.sh runs both over one fixture table.
#
#   conventional_title.sh [fallback subject] < text
#
# The rules, in order:
#   * leading `[tags]` and `KEY:` card key prefixes are dropped, in any order
#     (a webhook can tag every card it files, and the key is not part of the
#     change; a key with no colon after it stays, so `GPT-4 support` and
#     `CVE-2024-1234: patch` keep their subjects);
#   * the first non-blank line is the text, its whitespace collapsed;
#   * a line that already is `type(scope)!: subject` with a listed type is kept,
#     the type written in lower case; an unlisted type, an empty scope or a
#     missing colon is not a header;
#   * anything else becomes `fix: <line>`, and a header with no subject, or no
#     text at all, takes the fallback subject (default `apply the requested fix`);
#   * the result is at most CONVENTIONAL_TITLE_MAX code points (default 256,
#     GitHub's title limit), cut so a combining mark is never left without its
#     base, and a scope that would leave fewer than 10 code points for the
#     subject is dropped rather than cut in half. A trailing period is neither
#     added nor removed.
set -euo pipefail

fallback="${1:-apply the requested fix}"
max="${CONVENTIONAL_TITLE_MAX:-256}"

exec jq -Rs -r --arg fallback "$fallback" --argjson max "$max" '
  def types: ["feat","fix","chore","docs","refactor","perf","test","build","ci","style","revert"];
  def key: "[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}";
  def trim: sub("\\A\\s+"; "") | sub("\\s+\\z"; "");
  def extender($cp):
    ($cp >= 768 and $cp <= 879) or ($cp >= 6832 and $cp <= 6911) or
    ($cp >= 7616 and $cp <= 7679) or ($cp >= 8400 and $cp <= 8447) or
    ($cp >= 65024 and $cp <= 65039) or ($cp >= 65056 and $cp <= 65071) or
    $cp == 8205 or ($cp >= 127995 and $cp <= 127999);
  def fit($limit):
    explode as $cps
    | if ($cps | length) <= $limit then .
      else
        ($limit | until(. == 0 or ((extender($cps[.])) | not); . - 1)) as $n
        | $cps[:$n] | implode
      end;

  . as $input
  | ($input
     | trim
     | sub("\\A(?:\\s*(?:\\[[^\\]]*\\]|" + key + ":))+\\s*"; "")
     | gsub("\r\n|[\r\u000b\u000c\u0085\u2028\u2029]"; "\n")
     | split("\n")
     | map(trim)
     | map(select(. != ""))
     | (first // "")
     | gsub("\\s+"; " ")) as $line
  | ($line
     | capture("\\A(?<type>feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(?<scope>\\([^()\\s][^()]*\\))?(?<bang>!)?:\\s*(?<subject>.*)\\z"; "i")?
     // null) as $found
  | (if $found != null and (types | index($found.type | ascii_downcase)) != null
     then {type: ($found.type | ascii_downcase), scope: ($found.scope // ""), bang: ($found.bang // ""), subject: ($found.subject | trim)}
     else {type: "fix", scope: "", bang: "", subject: $line}
     end) as $parts
  | ($parts.subject | if . == "" then $fallback else . end) as $subject
  | (if ($parts.type + $parts.scope + $parts.bang | length) + 2 + 10 > $max then "" else $parts.scope end) as $scope
  | ($parts.type + $scope + $parts.bang + ": " + $subject)
  | fit($max)
  | sub("\\s+\\z"; "")
'
