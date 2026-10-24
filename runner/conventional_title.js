'use strict';
// The title of a pull request and the message of a commit, as one Conventional
// Commits header: `type(scope)!: subject`. The same rules, in the same order,
// as scripts/conventional_title.sh (the CI door's) and as SRE Agent's own
// SreCore.Remediation.ConventionalTitle, so a pull request reads the same
// whichever door opened it. tests/conventional_title_test.sh runs this and the
// script over one fixture table, and the platform runs a copy of that table.
//
// Standard library only: this file is installed on a machine the customer owns.

const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert'];
const MAX_TITLE = 256;
const DEFAULT_FALLBACK = 'apply the requested fix';

// The least room a cut header keeps for its subject; a scope that would leave
// less is dropped instead of cut in half.
const MIN_SUBJECT = 10;

// Whitespace is a space or a tab, and a line break is one of the characters
// below. JavaScript's own `\s` and `trim()` take U+FEFF for whitespace and
// leave U+0085 out, where jq's Oniguruma and the platform's PCRE do the
// opposite, so no class an engine defines for itself is used. U+FEFF is
// removed before anything else.
const SPACE = '[ \\t\\n\\r\\u000b\\u000c\\u0085\\u2028\\u2029]';
const BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/u;
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'gu');
const BLANK_EDGES = /^[ \t]+|[ \t]+$/gu;

const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}$/;

// A subject made only of combining marks has nothing to read. The marks are
// listed by block (the combining diacritical blocks, the variation selectors
// and the zero width joiner) rather than as \p{M}, because each engine reads
// \p{M} from the Unicode version it ships, and a mark assigned since would
// split the doors.
const MARKS_ONLY = /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u200d]+$/u;

// The spec's header. The type is matched without regard to case and judged
// afterwards against the list in ASCII, because a regular expression that
// folds case also folds U+017F (long s) onto `s` and would let `docſ` through.
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([^() \\t][^()]*\\))?(!)?:[ \\t]*(.*)$`, 'iu');

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

const codePoints = (text) => Array.from(text).length;

function asciiLower(text) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// The card key as a pattern matching its ASCII letters in either case and
// nothing else. Only a key of the card the request came from is a prefix a
// title loses; any other key-shaped word (`SHA-256:`, another card's key) is
// part of the subject.
function keyPattern(cardKey) {
  if (typeof cardKey !== 'string' || !KEY_SHAPE.test(cardKey)) return '';
  const letters = Array.from(cardKey, (c) => (/[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join('');
  return `|${letters}(?::|(?=${SPACE}))`;
}

// Leading `[tags]` and the card's key, in any order. Each alternative starts
// with a literal, so a run of whitespace between them cannot be split two ways.
function prefixes(cardKey) {
  return new RegExp(`^(?:${SPACE}*(?:\\[[^\\]]*\\]${keyPattern(cardKey)}))+${SPACE}*`, 'u');
}

function firstLine(text, cardKey) {
  const trimmed = text.replace(/\ufeff/gu, '').replace(EDGES, '').replace(prefixes(cardKey), '');
  const line = trimmed
    .split(BREAK)
    .map((candidate) => candidate.replace(BLANK_EDGES, ''))
    .find((candidate) => candidate !== '');
  return (line || '').replace(/[ \t]+/gu, ' ');
}

// At most `max` code points, ending on a grapheme boundary and never with a
// combining mark cut off its base.
function fit(text, max) {
  if (codePoints(text) <= max) return text;
  if (segmenter) {
    let kept = '';
    let used = 0;
    for (const { segment } of segmenter.segment(text)) {
      const size = codePoints(segment);
      if (used + size > max) break;
      kept += segment;
      used += size;
    }
    return kept;
  }
  return Array.from(text).slice(0, max).join('');
}

const finish = (text, max) => fit(text, max).replace(/[ \t]+$/u, '');

// `text` is whatever the agent said first, `fallback` the subject for a header
// with none, `cardKey` the key of the card the request came from, when the
// door knows it. Anything that is not text is no text.
function conventionalTitle(text, fallback = DEFAULT_FALLBACK, { max = MAX_TITLE, cardKey } = {}) {
  const subjectFallback = fallback || DEFAULT_FALLBACK;
  const line = typeof text === 'string' ? firstLine(text, cardKey) : '';
  const found = HEADER.exec(line);

  let type = 'fix';
  let scope = '';
  let bang = '';
  let subject = line;
  if (found && TYPES.includes(asciiLower(found[1]))) {
    type = asciiLower(found[1]);
    scope = found[2] || '';
    bang = found[3] || '';
    subject = found[4].replace(BLANK_EDGES, '');
  }
  if (subject === '' || MARKS_ONLY.test(subject)) subject = subjectFallback;

  if (codePoints(type + scope + bang) + 2 + MIN_SUBJECT > max) scope = '';
  const prefix = `${type}${scope}${bang}`;
  const title = finish(`${prefix}: ${subject}`, max);
  // A cut that left nothing after the colon is not a header.
  return codePoints(title) <= codePoints(prefix) + 1 ? finish(`${prefix}: ${subjectFallback}`, max) : title;
}

module.exports = { conventionalTitle, TYPES, MAX_TITLE, DEFAULT_FALLBACK };
