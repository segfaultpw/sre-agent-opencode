'use strict';
// Unit tests for runner/conventional_title.js, run by tests/conventional_title_test.sh
// with the same fixture table scripts/conventional_title.sh is run against, so
// the two implementations cannot drift apart without a case failing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { conventionalTitle, DEFAULT_FALLBACK, MAX_TITLE } = require('../runner/conventional_title.js');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture', 'conventional_titles.json'), 'utf8'));
let failed = 0;

// Pieces that are hard for one engine or another: the whitespace and line
// breaks each defines differently, a byte order mark, keys, combining marks,
// joiners and emoji. The fuzz below and the jq comparison in
// conventional_title_test.sh both draw from them.
const PIECES = [
  '[', ']', '(', ')', '!', ':', ' ', '\t', '\n', '\r\n', '\r', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029',
  '\u00a0', '\u3000', '\ufeff', 'fix', 'feat', 'Chore', 'NUM-12', 'num-12', 'NUM-123', 'OPS-1', 'SHA-256',
  '\u017f', 'é', '日', '\u0301', '\u200d', '\ufe0f', '😀', '👨', 'a',
];

function seeded(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    // The high bits: the low ones of this generator cycle through a handful
    // of values, which would leave most pieces unpicked.
    return state >>> 16;
  };
}

function generated(count, seed, maxPieces) {
  const next = seeded(seed);
  const inputs = [];
  for (let i = 0; i < count; i += 1) {
    let text = '';
    const length = next() % maxPieces;
    for (let j = 0; j < length; j += 1) text += PIECES[next() % PIECES.length];
    inputs.push(text);
  }
  return inputs;
}

// `--fuzz N` prints N generated inputs with this module's title for each, as
// JSON lines, for the shell test to run through the jq filter.
const fuzzAt = process.argv.indexOf('--fuzz');
if (fuzzAt !== -1) {
  for (const input of generated(Number(process.argv[fuzzAt + 1]), 4242, 60)) {
    process.stdout.write(`${JSON.stringify({ input, title: conventionalTitle(input, undefined, { cardKey: 'NUM-12' }) })}\n`);
  }
  process.exit(0);
}

function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

const codePoints = (text) => Array.from(text).length;

const optionsOf = (c) => ({ ...(c.max ? { max: c.max } : {}), ...(c.key ? { cardKey: c.key } : {}) });

for (const c of cases) {
  check(`[js] ${c.name}`, () => {
    assert.equal(conventionalTitle(c.input, c.fallback, optionsOf(c)), c.expected);
  });
}

check('[js] the output of every case is a fixed point', () => {
  for (const c of cases) {
    const once = conventionalTitle(c.input, c.fallback, optionsOf(c));
    assert.equal(conventionalTitle(once, c.fallback, optionsOf(c)), once, c.name);
  }
});

check('[js] without a card key no key is dropped, and a key that is not key shaped is ignored', () => {
  assert.equal(conventionalTitle('NUM-12: widen it'), 'fix: NUM-12: widen it');
  assert.equal(conventionalTitle('NUM-12: widen it', undefined, { cardKey: 'NUM-12' }), 'fix: widen it');
  assert.equal(conventionalTitle('.*: widen it', undefined, { cardKey: '.*' }), 'fix: .*: widen it');
  assert.equal(conventionalTitle('NUM-12: widen it', undefined, { cardKey: 42 }), 'fix: NUM-12: widen it');
});

check('[js] the defaults are the 256 character limit and the stock fallback', () => {
  assert.equal(MAX_TITLE, 256);
  assert.equal(DEFAULT_FALLBACK, 'apply the requested fix');
  assert.equal(conventionalTitle(''), 'fix: apply the requested fix');
});

check('[js] input that is not text takes the fallback', () => {
  for (const value of [null, undefined, 42, {}, ['feat: x']]) {
    assert.equal(conventionalTitle(value, 'nothing usable'), 'fix: nothing usable');
  }
});

check('[js] the result is one line of at most 256 code points whatever it is given', () => {
  for (const text of generated(2000, 12345, 400)) {
    for (const options of [{}, { cardKey: 'NUM-12' }]) {
      const title = conventionalTitle(text, undefined, options);
      assert.ok(codePoints(title) <= 256, `too long for ${JSON.stringify(text)}`);
      assert.ok(!/[\n\r\u000b\u000c\u0085\u2028\u2029\ufeff]/u.test(title), `more than one line for ${JSON.stringify(text)}`);
      assert.match(title, /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^() \t][^()]*\))?!?: [^ \t]/u, JSON.stringify(text));
      assert.ok(!/^[^:]*: [\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u200d]+$/u.test(title), `a subject of marks alone for ${JSON.stringify(text)}`);
      assert.equal(conventionalTitle(title, undefined, options), title, `not a fixed point: ${JSON.stringify(text)}`);
    }
  }
});

check('[js] a cut never lands inside a grapheme', () => {
  const family = '👨‍👩‍👧';
  const title = conventionalTitle(`fix: ${family.repeat(100)}`, undefined, { max: 20 });
  assert.ok(codePoints(title) <= 20);
  assert.equal(title.slice('fix: '.length).replaceAll(family, ''), '');
});

check('[js] a long run of tags and whitespace is handled in linear time', () => {
  const started = Date.now();
  const title = conventionalTitle(`${'[a]   '.repeat(20000)}x`);
  assert.equal(title, 'fix: x');
  assert.ok(Date.now() - started < 2000, 'took too long');
});

check('[js] long whitespace runs at the edges and inside the line are handled in linear time', () => {
  const run = ' '.repeat(160000);
  const started = Date.now();
  assert.equal(conventionalTitle(`${run}fix: widen the pool${run}`), 'fix: widen the pool');
  assert.equal(conventionalTitle(`fix: a${run}b`), 'fix: a b');
  assert.equal(conventionalTitle(`\t${run}\n${run}fix: x\n${run}`), 'fix: x');
  assert.ok(Date.now() - started < 2000, 'took too long');
});

if (failed > 0) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
