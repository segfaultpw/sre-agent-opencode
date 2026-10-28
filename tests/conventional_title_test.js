'use strict';
// Unit tests for runner/conventional_title.js, run by tests/conventional_title_test.sh
// over the fixture table, which SRE Agent runs a byte for byte copy of against
// its own implementation, so the two cannot drift apart without a case failing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { conventionalTitle, validHeader, DEFAULT_FALLBACK, MAX_TITLE, TITLE_MAX } = require('../runner/conventional_title.js');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture', 'conventional_titles.json'), 'utf8'));
let failed = 0;

// Pieces that are hard to normalise: whitespace and line breaks that read
// differently in different engines, a byte order mark, keys, combining marks,
// joiners and emoji. The fuzz below draws from them.
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

check('[js] the runner caps a title at 72 characters while the shared normaliser keeps its 256 default', () => {
  assert.equal(TITLE_MAX, 72);
  assert.equal(MAX_TITLE, 256);
  const title = conventionalTitle(`feat(sso): ${'a'.repeat(200)}`, undefined, { max: TITLE_MAX });
  assert.equal(codePoints(title), 72);
  assert.ok(title.startsWith('feat(sso): a'));
});

check('[js] validHeader keeps a header that is already valid, byte for byte', () => {
  for (const header of [
    'feat(iam): add a read-only permission set for the reporting group',
    'fix: raise the pool ceiling',
    'chore(deps)!: drop node 18',
    'revert(api): undo the rename',
    'feat(a b): scope with an inner space',
    `fix: ${'a'.repeat(67)}`,
  ]) {
    assert.equal(validHeader(header), header);
  }
});

check('[js] validHeader surrounds nothing: edge blanks are taken off, nothing else is repaired', () => {
  assert.equal(validHeader('  fix: raise the ceiling \t'), 'fix: raise the ceiling');
});

check('[js] validHeader refuses what would need repair', () => {
  const refused = [
    'Raise the pool ceiling',
    'Feat(sso): add it',
    'FIX: add it',
    'wip(pool): raise it',
    'feat(): add it',
    'feat( sso): add it',
    'feat(sso)(more): add it',
    'feat(sso):add it',
    'feat(sso):  add it',
    'feat(sso) : add it',
    'feat(sso): ',
    'feat(sso):',
    'feat!(sso): add it',
    '[acme] feat(sso): add it',
    'NUM-12: feat(sso): add it',
    'fix: a\nsecond line',
    'fix: a\rsecond',
    'fix: a\u0085b',
    'fix: a b',
    'fix: a\u000bb',
    '﻿fix: add it',
    'fix: ́́',
    `fix: ${'a'.repeat(68)}`,
    'fix: a  b',
    'fix: a\tb',
    'feat(a\tb): x',
    'feat(a  b): x',
    'fix: \u00a0',
    'fix: \u3000',
    'fix: \u00a0\u3000',
    '',
    '   ',
  ];
  for (const text of refused) assert.equal(validHeader(text), null, JSON.stringify(text));
  for (const value of [null, undefined, 42, {}, ['fix: x']]) assert.equal(validHeader(value), null);
});

check('[js] validHeader counts code points against its limit, and the limit is an option', () => {
  const header = `fix: ${'😀'.repeat(67)}`;
  assert.equal(codePoints(header), 72);
  assert.equal(validHeader(header), header);
  assert.equal(validHeader(`${header}😀`), null);
  assert.equal(validHeader(`fix: ${'a'.repeat(100)}`, { max: 120 }), `fix: ${'a'.repeat(100)}`);
});

check('[js] whatever validHeader accepts is a fixed point of the normaliser at the same limit', () => {
  for (const text of generated(3000, 777, 40)) {
    const kept = validHeader(text);
    if (kept !== null) assert.equal(conventionalTitle(kept, undefined, { max: TITLE_MAX }), kept, JSON.stringify(text));
  }
});

if (failed > 0) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
