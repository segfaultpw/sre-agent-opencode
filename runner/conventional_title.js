'use strict';
// The title of a pull request and the message of a commit, as one Conventional
// Commits header: `type(scope)!: subject`. The same rules, in the same order,
// as SRE Agent's own SreCore.Remediation.ConventionalTitle, so a pull request
// reads the same whichever runner opened it. tests/conventional_title_test.sh
// runs this over the fixture table, and the platform runs a copy of that table.
//
// Standard library only: this file is installed on a machine the customer owns.

const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert'];
const MAX_TITLE = 256;
// What the runner writes as a pull request title and a commit headline: the
// length a squash merge keeps on the default branch. The normaliser's own default
// stays MAX_TITLE, the limit the shared fixture table is written against.
const TITLE_MAX = 72;
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
// Edges are trimmed by scanning, not by a `^x+|x+$` expression, which takes time quadratic in a long whitespace run
// (160,000 spaces took 13.9 s); the machine door hands this the agent's whole first line, unbounded. Every character
// in both sets is a single UTF-16 unit, so indexing by unit is exact.
const SPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029']);
const BLANK_CHARS = new Set([' ', '\t']);

function trimSet(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.has(text[start])) start += 1;
  while (end > start && chars.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

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
  const trimmed = trimSet(text.replace(/\ufeff/gu, ''), SPACE_CHARS).replace(prefixes(cardKey), '');
  const line = trimmed
    .split(BREAK)
    .map((candidate) => trimSet(candidate, BLANK_CHARS))
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
    subject = trimSet(found[4], BLANK_CHARS);
  }
  if (subject === '' || MARKS_ONLY.test(subject)) subject = subjectFallback;

  if (codePoints(type + scope + bang) + 2 + MIN_SUBJECT > max) scope = '';
  const prefix = `${type}${scope}${bang}`;
  const title = finish(`${prefix}: ${subject}`, max);
  // A cut that left nothing after the colon is not a header.
  return codePoints(title) <= codePoints(prefix) + 1 ? finish(`${prefix}: ${subjectFallback}`, max) : title;
}

// The strict header, for a title the model proposed. The type is lower case and
// on the list, the scope (when there is one) has no inner parentheses and does not
// start with a blank, a `: ` follows, and the subject starts with a non-blank.
// Nothing is repaired: prose, an upper case type, a tag, a card key or a missing
// space after the colon is not a header here. The engine's `.` leaves out the
// line separators it knows and not VT, FF or U+0085, so a break is refused on its own.
const STRICT = new RegExp(`^(${TYPES.join('|')})(\\([^() \\t][^()]*\\))?!?: ([^ \\t].*)$`, 'u');

// The header, with the blanks round it taken off, when the whole text already is
// one Conventional Commits header of at most `max` code points; otherwise null.
function validHeader(text, { max = TITLE_MAX } = {}) {
  if (typeof text !== 'string' || text.includes('﻿')) return null;
  const header = trimSet(text, BLANK_CHARS);
  if (header === '' || BREAK.test(header) || codePoints(header) > max) return null;
  // The normaliser folds every run of blanks to one space, so a header with a tab
  // or a run of spaces is not one it would keep.
  if (header.includes('\t') || / {2,}/.test(header)) return null;
  const found = STRICT.exec(header);
  if (!found) return null;
  const subject = found[3];
  if (MARKS_ONLY.test(trimSet(subject, BLANK_CHARS)) || /^[ \u00a0\u3000]*$/u.test(subject)) return null;
  return header;
}

module.exports = { conventionalTitle, validHeader, TYPES, MAX_TITLE, TITLE_MAX, MIN_SUBJECT, DEFAULT_FALLBACK };
