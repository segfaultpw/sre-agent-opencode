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

for (const c of cases) {
  check(`[js] ${c.name}`, () => {
    const options = c.max ? { max: c.max } : {};
    assert.equal(conventionalTitle(c.input, c.fallback, options), c.expected);
  });
}

check('[js] the output of every case is a fixed point', () => {
  for (const c of cases) {
    const options = c.max ? { max: c.max } : {};
    const once = conventionalTitle(c.input, c.fallback, options);
    assert.equal(conventionalTitle(once, c.fallback, options), once, c.name);
  }
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
  const pieces = ['[', ']', '(', ')', '!', ':', ' ', '\n', '\r\n', 'fix', 'feat', 'NUM-1', 'é', '日', '́', '‍', '😀', 'a'];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 2000; i += 1) {
    let text = '';
    const length = next() % 400;
    for (let j = 0; j < length; j += 1) text += pieces[next() % pieces.length];
    const title = conventionalTitle(text);
    assert.ok(codePoints(title) <= 256, `too long for ${JSON.stringify(text)}`);
    assert.ok(!/[\r\n]/.test(title), `more than one line for ${JSON.stringify(text)}`);
    assert.match(title, /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^()\s][^()]*\))?!?: \S/u, JSON.stringify(text));
    assert.equal(conventionalTitle(title), title, `not a fixed point: ${JSON.stringify(text)}`);
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

if (failed > 0) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
