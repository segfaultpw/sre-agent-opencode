'use strict';
// The title of a pull request and the message of a commit, as one Conventional
// Commits header: `type(scope)!: subject`. The same rules, in the same order,
// as scripts/conventional_title.sh (the CI door's) and as SRE Agent's own
// SreCore.Remediation.ConventionalTitle, so a pull request reads the same
// whichever door opened it. tests/conventional_title_test.sh runs this and the
// script over one fixture table.
//
// Standard library only: this file is installed on a machine the customer owns.

const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert'];
const MAX_TITLE = 256;
const DEFAULT_FALLBACK = 'apply the requested fix';

// The least room a cut header keeps for its subject; a scope that would leave
// less is dropped instead of cut in half.
const MIN_SUBJECT = 10;

const KEY = '[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}';

// Leading `[tags]` and `KEY:` prefixes, in any order. A key counts only with
// the colon right after it, so `GPT-4 support` and `CVE-2024-1234: patch` keep
// their subjects. Each alternative starts with a literal, so a run of
// whitespace between them cannot be split two ways.
const PREFIXES = new RegExp(`^(?:\\s*(?:\\[[^\\]]*\\]|${KEY}:))+\\s*`, 'u');

// The spec's header. The type is matched without regard to case and judged
// afterwards against the list in ASCII, because a regular expression that
// folds case also folds U+017F (long s) onto `s` and would let `docſ` through.
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s][^()]*\\))?(!)?:\\s*(.*)$`, 'iu');

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

const codePoints = (text) => Array.from(text).length;

function asciiLower(text) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function firstLine(text) {
  const trimmed = text.trim().replace(PREFIXES, '');
  const line = trimmed
    .split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  return (line || '').replace(/\s+/gu, ' ');
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

// `text` is whatever the agent said first, `fallback` the subject for a header
// with none. Anything that is not text is no text.
function conventionalTitle(text, fallback = DEFAULT_FALLBACK, { max = MAX_TITLE } = {}) {
  const line = typeof text === 'string' ? firstLine(text) : '';
  const found = HEADER.exec(line);

  let type = 'fix';
  let scope = '';
  let bang = '';
  let subject = line;
  if (found && TYPES.includes(asciiLower(found[1]))) {
    type = asciiLower(found[1]);
    scope = found[2] || '';
    bang = found[3] || '';
    subject = found[4].trim();
  }
  if (subject === '') subject = fallback || DEFAULT_FALLBACK;

  if (codePoints(type + scope + bang) + 2 + MIN_SUBJECT > max) scope = '';
  return fit(`${type}${scope}${bang}: ${subject}`, max).replace(/\s+$/u, '');
}

module.exports = { conventionalTitle, TYPES, MAX_TITLE, DEFAULT_FALLBACK };
