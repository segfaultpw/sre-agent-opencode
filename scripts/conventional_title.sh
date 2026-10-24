#!/usr/bin/env bash
# Reads text on stdin and prints it as one Conventional Commits header,
# `type(scope)!: subject`, the way SRE Agent's own pull requests are titled.
# The CI workflow runs it over the title the opencode action gave the pull
# request; runner/conventional_title.js is the same rules for the machine
# door, and tests/conventional_title_test.sh runs both over one fixture table.
#
#   CARD_KEY=<key> conventional_title.sh [fallback subject] < text
#
# The rules, in order:
#   * every U+FEFF is removed. Whitespace is a space or a tab; a line break is
#     LF, CR, CR LF, VT, FF, U+0085, U+2028 or U+2029. Nothing else is either,
#     because every engine that runs these rules (jq's Oniguruma, Node, the
#     platform's PCRE) draws its own Unicode whitespace class differently;
#   * leading `[tags]` are dropped, and so is the card's own key (CARD_KEY,
#     matched in ASCII without regard to case) followed by a colon or
#     whitespace, in any order. No other key is a prefix: `SHA-256: verify`
#     and another card's `OPS-12: widen` keep their subjects. A CARD_KEY that
#     is not key shaped is ignored;
#   * the first non-blank line is the text, its spaces and tabs collapsed;
#   * a line that already is `type(scope)!: subject` with a listed type is kept,
#     the type written in lower case; an unlisted type, an empty scope or a
#     missing colon is not a header;
#   * anything else becomes `fix: <line>`, and a header with no subject, a
#     subject made only of combining marks (the combining diacritical blocks,
#     the variation selectors and the zero width joiner), or no text at all
#     takes the fallback subject (default `apply the requested fix`);
#   * the result is at most CONVENTIONAL_TITLE_MAX code points (default 256,
#     GitHub's title limit), cut so a mark, a joiner, a skin tone or a joined
#     pictograph is never left without what it attaches to (the grapheme
#     boundary the Node module and the platform cut on), and a scope that
#     would leave fewer than 10 code points for the subject is dropped rather
#     than cut in half; a cut that leaves no subject takes the fallback
#     subject. A trailing period is neither added nor removed.
#
# Written for jq 1.6 and later: every builtin used here is in the jq 1.6 manual.
set -euo pipefail

fallback="${1:-apply the requested fix}"
max="${CONVENTIONAL_TITLE_MAX:-256}"

exec jq -Rs -r --arg fallback "$fallback" --argjson max "$max" --arg key "${CARD_KEY:-}" '
  def types: ["feat","fix","chore","docs","refactor","perf","test","build","ci","style","revert"];
  def space: "[ \\t\n\r\u000b\u000c\u0085\u2028\u2029]";
  def trim_space: sub("\\A" + space + "+"; "") | sub(space + "+\\z"; "");
  def trim_blank: sub("\\A[ \\t]+"; "") | sub("[ \\t]+\\z"; "");
  # The card key as a pattern that matches its ASCII letters in either case
  # and nothing else, so U+017F (long s) is not an `s`.
  def caseless:
    explode
    | map(if (. >= 65 and . <= 90) or (. >= 97 and . <= 122)
          then "[" + ([.] | implode | ascii_downcase) + ([.] | implode | ascii_upcase) + "]"
          else [.] | implode
          end)
    | join("");
  # Combining marks by block (the combining diacritical blocks, the variation
  # selectors, the zero width joiner) rather than \p{M}, which each engine
  # reads from the Unicode version it ships.
  def marks_only: test("\\A[\\x{0300}-\\x{036F}\\x{1AB0}-\\x{1AFF}\\x{1DC0}-\\x{1DFF}\\x{20D0}-\\x{20FF}\\x{FE00}-\\x{FE0F}\\x{FE20}-\\x{FE2F}\\x{200D}]+\\z");
  # What a cut must not separate from the code point before it: a mark of any
  # script (a spacing mark too, as in Devanagari), a joiner, a skin tone. The
  # Node module and the platform cut on a grapheme boundary, which this
  # approximates without a grapheme table.
  def extender($cp):
    ($cp >= 768 and $cp <= 879) or ($cp >= 6832 and $cp <= 6911) or
    ($cp >= 7616 and $cp <= 7679) or ($cp >= 8400 and $cp <= 8447) or
    ($cp >= 65024 and $cp <= 65039) or ($cp >= 65056 and $cp <= 65071) or
    $cp == 8205 or ($cp >= 127995 and $cp <= 127999) or
    ([$cp] | implode | test("\\A\\p{M}\\z"));
  # A pictograph after a zero width joiner belongs to the same emoji (a family
  # emoji is three pictographs joined so), so the cut does not fall between
  # them either.
  def pictograph($cp): $cp >= 126976 or ($cp >= 8192 and $cp <= 11263);
  def fit($limit):
    explode as $cps
    | if ($cps | length) <= $limit then .
      else
        ($limit
         | until(. == 0 or ((extender($cps[.]) | not) and ($cps[. - 1] != 8205 or (pictograph($cps[.]) | not))); . - 1)) as $n
        | $cps[:$n] | implode
      end;
  def finish($limit): fit($limit) | sub("[ \\t]+\\z"; "");

  (if ($key | test("\\A[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}\\z"))
   then "|" + ($key | caseless) + "(?::|(?=" + space + "))"
   else ""
   end) as $key_prefix
  | ("\\A(?:" + space + "*(?:\\[[^\\]]*\\]" + $key_prefix + "))+" + space + "*") as $prefixes
  | (gsub("\ufeff"; "")
     | trim_space
     | sub($prefixes; "")
     | gsub("\r\n|[\r\u000b\u000c\u0085\u2028\u2029]"; "\n")
     | split("\n")
     | map(trim_blank)
     | map(select(. != ""))
     | (first // "")
     | gsub("[ \\t]+"; " ")) as $line
  | ($line
     | capture("\\A(?<type>feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(?<scope>\\([^() \\t][^()]*\\))?(?<bang>!)?:[ \\t]*(?<subject>.*)\\z"; "i")?
     // null) as $found
  | (if $found != null and any(types[]; . == ($found.type | ascii_downcase))
     then {type: ($found.type | ascii_downcase), scope: ($found.scope // ""), bang: ($found.bang // ""), subject: ($found.subject | trim_blank)}
     else {type: "fix", scope: "", bang: "", subject: $line}
     end) as $parts
  | ($parts.subject | if . == "" or marks_only then $fallback else . end) as $subject
  | (if ($parts.type + $parts.scope + $parts.bang | length) + 2 + 10 > $max then "" else $parts.scope end) as $scope
  | ($parts.type + $scope + $parts.bang) as $prefix
  | ($prefix + ": " + $subject | finish($max)) as $title
  | if ($title | length) <= ($prefix | length) + 1
    then $prefix + ": " + $fallback | finish($max)
    else $title
    end
'
