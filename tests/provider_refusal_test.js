'use strict';
// How the runner tells an AI provider's refusal from every other way a run can
// end, and how it scrubs the provider's words (runner/provider_refusal.js).
// The scrubber is held to tests/fixture/provider_messages.json, the file the
// platform's scrubber is held to byte for byte: each repository's test pins the
// file's SHA-256, so a change to one copy fails the other repository's suite
// until both move together. A repeated run in the fixture is written
// {{repeat:<chars>:<n>}} and expanded here, so no key-shaped literal is
// committed (GitHub's push protection reads one as a leaked key).
// Run with `node tests/provider_refusal_test.js`.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { CLASSES, EVENTS_MAX, RAW_MAX_CODE_POINTS, MESSAGE_MAX_BYTES, eventFrom, remember, classify, scrub, wellFormed } = require(path.join(root, 'runner', 'provider_refusal.js'));

const FIXTURE_PATH = path.join(__dirname, 'fixture', 'provider_messages.json');
const FIXTURE_SHA256 = '4f245e3a446a3fb3f2f0434418c192c55f04efa5c8543e2aad788fe7c205ed76';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function expand(text) {
  return text.replace(/\{\{repeat:([^:}]+):(\d+)\}\}/gu, (_all, chars, count) => chars.repeat(Number(count)));
}

// The runner's redact() for a test: every secret of 8 bytes or more by value.
function redactWith(secrets) {
  return (text) => secrets.filter((secret) => Buffer.byteLength(secret) >= 8).reduce((out, secret) => out.split(secret).join('[redacted]'), String(text));
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

check('the shared fixture holds in the runner, and its digest is the platform\'s', () => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
  assert.equal(digest, FIXTURE_SHA256);
  assert.equal(fixture.version, 1);
  const wrong = [];
  for (const entry of fixture.cases) {
    const secrets = entry.secrets.map(expand);
    const got = scrub(expand(entry.input), redactWith(secrets), secrets);
    if (got !== expand(entry.output)) wrong.push(`${entry.name}: ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, []);
});

check('every case holds with the removal by value alone, with no redact function', () => {
  const wrong = [];
  for (const entry of fixture.cases) {
    const secrets = entry.secrets.map(expand);
    const got = scrub(expand(entry.input), null, secrets);
    if (got !== expand(entry.output)) wrong.push(`${entry.name}: ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, []);
});

check('every case has a distinct name and no key-shaped literal is committed', () => {
  const names = fixture.cases.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  const body = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.doesNotMatch(body, /sk-ant-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(body, /AKIA[0-9A-Z]{16}/);
  assert.doesNotMatch(body, /ghp_[A-Za-z0-9]{20,}/);
});

// Each template is a context, the secret and what follows. A line break (and a
// wrapped indentation, a tab, a NUL) is inserted at every position of the whole
// text, before and inside the secret, and no window of eight characters of the
// secret may survive in the output.
const TEMPLATES = [
  ['an access key id', 'Request from ', `AKIA${'B'.repeat(16)}`, ' failed', []],
  ['a temporary access key id', 'session ', `ASIA${'C'.repeat(16)}`, ' expired', []],
  ['a google key', 'API key ', `AIza${'D'.repeat(35)}`, ' not valid', []],
  ['a github token', 'user ', `ghp_${'e'.repeat(30)}`, ' x', []],
  ['a fine grained token', 'token ', `github_pat_${'f'.repeat(30)}`, ' bad', []],
  ['a slack token', 'bot ', `xoxb-${'1'.repeat(12)}-abc`, ' revoked', []],
  ['an anthropic key', 'key ', `sk-ant-api03-${'A'.repeat(40)}`, ' rejected', []],
  ['an openai key', 'key: ', `sk-proj-${'a'.repeat(30)}`, '. Next sentence', []],
  ['a hugging face token', 'token ', `hf_${'a'.repeat(34)}`, ' bad', []],
  ['a replicate token', 'model ', `r8_${'b'.repeat(37)}`, ' bad', []],
  ['a gitlab token', 'token ', `glpat-${'d'.repeat(20)}`, ' bad', []],
  ['a stripe key', 'key ', `sk_live_${'e'.repeat(24)}`, ' bad', []],
  ['a jwt', 'error at line abc ', `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`, ' done', []],
  ['a bearer token', 'Authorization: Bearer ', 'abc123def456', ' x', []],
  ['a basic credential', 'Authorization: Basic ', 'dXNlcjpwYXNzd29yZA==', ' x', []],
  ['an api key header', 'x-api-key: ', 'a'.repeat(32), ' sent', []],
  ['an ocp apim subscription key header', 'Ocp-Apim-Subscription-Key: ', 'q'.repeat(32), ' sent', []],
  ['a password field', 'login failed, password: ', 'hunter2xyz', ' for user', []],
  ['a json key', '{"api_key": "', 'd'.repeat(40), '", "m": 1}', []],
  ['a json secret access key', '{"SecretAccessKey": "', `${'a'.repeat(20)}/${'B'.repeat(19)}`, '"}', []],
  ['a query token', 'GET https://api.example.com/v1/models?access_token=', 't'.repeat(20), '&x=1 failed', []],
  ['a url fragment token', 'redirect https://app.example.com/cb#access_token=', 't'.repeat(30), '&state=1 end', []],
  ['a url password', 'proxy https://user:', 'hunter2xyz', '@proxy.example.com failed', []],
  ['an arn', 'role ', 'arn:aws:iam::123456789012:role/sre-agent-task', ' denied', []],
  ['an account id', 'account ', '123456789012', ' is not subscribed', []],
  ['a long run', 'gw ', 'x'.repeat(60), ' end', []],
  ['a query name with a percent escaped underscore', 'GET https://api.example.com/v1/models?api%5Fkey=', 't'.repeat(20), '&x=1 failed', []],
  ['a query name with a percent escaped hyphen', 'GET https://api.example.com/v1/models?x%2Dapi%2Dkey=', 'u'.repeat(20), '&y=2 failed', []],
  ['an account id after four hex characters and a dash', 'req abcd-', '123456789012', ' failed', []],
  ['an account id after a short uuid look-alike', 'id 123e4567-e89b-12d3-', '123456789012', ' failed', []],
  ['a known key', 'key ', 'KEY12345678', ' rejected', ['KEY12345678']],
];

// A line break, a tab, a NUL, and every kind of invisible or exotic space: each
// is a gap or a marker to the rules, never something that hides a key.
const BREAKS = ['\n', '\r\n    ', '\t', '\0', '\u00A0', '\u2028', '\uFEFF', '\u200B', '\u2060', '\u034F', '\uFE0F', '\u3000', '\uFFFD', '\u0301', '\u0301\u0302', '\uD800', '\uDC00'];

function windows(secret, size) {
  const chars = Array.from(secret);
  const out = [];
  for (let start = 0; start <= Math.max(chars.length - size, 0); start += 1) out.push(chars.slice(start, start + size).join(''));
  return out;
}

check('no part of a secret survives a line break at any position', () => {
  const leaks = [];
  for (const [name, before, secret, after, keys] of TEMPLATES) {
    const whole = Array.from(before + secret + after);
    for (const separator of BREAKS) {
      for (let at = 1; at < whole.length; at += 1) {
        const input = whole.slice(0, at).join('') + separator + whole.slice(at).join('');
        const out = scrub(input, redactWith(keys), keys).replace(/\s/g, '');
        if (windows(secret, Math.min(8, secret.length)).some((window) => out.includes(window))) leaks.push(`${name} ${JSON.stringify(separator)} at ${at}`);
      }
    }
  }
  assert.deepEqual(leaks, []);
});

check('the same holds with a break before and another inside the secret', () => {
  const leaks = [];
  for (const [name, before, secret, after, keys] of TEMPLATES) {
    const chars = Array.from(secret);
    for (let at = 1; at < chars.length; at += 1) {
      const input = `${before.trimEnd()}\n${chars.slice(0, at).join('')}\n${chars.slice(at).join('')}${after}`;
      const out = scrub(input, redactWith(keys), keys).replace(/\s/g, '');
      if (windows(secret, Math.min(8, secret.length)).some((window) => out.includes(window))) leaks.push(`${name} at ${at}`);
    }
  }
  assert.deepEqual(leaks, []);
});

check('a secret is removed in every form an endpoint that echoes a request may quote it', () => {
  const secret = 'abc/def+ghi jkl"mno=pqr';
  const forms = [secret, 'abc%2Fdef%2Bghi+jkl%22mno%3Dpqr', 'abc%2Fdef%2Bghi%20jkl%22mno%3Dpqr', 'abc/def+ghi jkl\\"mno=pqr', 'abc\\/def+ghi jkl\\"mno=pqr'];
  for (const form of forms) {
    const out = scrub(`the gateway said ${form} is not allowed`, null, [secret]);
    assert.equal(out, 'the gateway said [redacted] is not allowed', form);
  }
});

check('a secret of fewer than eight bytes is ignored by the removal', () => {
  assert.equal(scrub('x and ollama and none', null, ['x', 'ollama', 'none']), 'x and ollama and none');
});

check('the output is one line of at most 500 bytes, cut on a character', () => {
  const out = scrub('\u{E9}'.repeat(400), null, []);
  assert.equal(Buffer.byteLength(out), 500);
  assert.equal(Array.from(out).length, 250);
  const odd = scrub(`a${'\u{20AC}'.repeat(400)}`, null, []);
  assert.ok(Buffer.byteLength(odd) <= MESSAGE_MAX_BYTES);
  assert.equal(Buffer.byteLength(odd), 1 + 3 * 166);
  assert.doesNotMatch(odd, /[\r\n\t]/);
  assert.equal(Buffer.from(odd, 'utf8').toString('utf8'), odd);
});

check('a bad byte, a no-break space and every JS-only space are read as the platform reads them', () => {
  const bad = Buffer.from([0x6b, 0x65, 0x79, 0x20, 0x73, 0x6b, 0x2d, 0x61, 0x6e, 0x74, 0x2d, 0xff, 0x41, 0x41]).toString('utf8');
  assert.equal(scrub(`${bad}${'A'.repeat(40)}`, null, []), 'key [redacted]');
  for (const space of ['\u{A0}', '\u{1680}', '\u{2000}', '\u{200A}', '\u{2028}', '\u{202F}', '\u{205F}', '\u{3000}']) {
    assert.equal(scrub(`Request from${space}AKIA${'B'.repeat(16)} failed`, null, []), 'Request from [redacted] failed', JSON.stringify(space));
  }
  assert.equal(scrub('foo\u{A0}bar', null, []), 'foo bar');
});

check('a huge message costs what 64 KiB costs, and a token the read ended inside of is dropped', () => {
  const started = Date.now();
  const out = scrub(`${'word '.repeat(40000)}`, null, []);
  assert.ok(Date.now() - started < 2000);
  assert.ok(Buffer.byteLength(out) <= MESSAGE_MAX_BYTES);
  const tail = scrub(`${'a '.repeat(32000)}sk-ant-${'B'.repeat(80000)}`, null, []);
  assert.equal(tail.includes('BBBB'), false);
  const straddle = `${'x '.repeat(32760)}sk-ant-api03-${'C'.repeat(40)} ${'y '.repeat(10)}`;
  assert.equal(scrub(straddle, null, []).includes('CCCCCCCC'), false);
  const wrapped = `${'z '.repeat(32760)}AKIA${'D'.repeat(8)}\n${'D'.repeat(8)} end`;
  assert.equal(scrub(wrapped, null, []).includes('DDDDDDDD'), false);
});

check('anything that is not text, and a throwing redact function, scrub to nothing and never throw', () => {
  for (const value of [null, undefined, 42, {}, []]) assert.equal(scrub(value, null, []), '');
  assert.equal(scrub('words', () => { throw new Error('boom'); }, []), '');
  assert.equal(scrub('', null, []), '');
});

check('the redact function runs on the raw words and on the result', () => {
  const secret = 'provider-key-1234';
  const seen = [];
  const redact = (text) => {
    seen.push(text);
    return text.split(secret).join('[redacted]');
  };
  assert.equal(scrub(`invalid key ${secret}`, redact, []), 'invalid key [redacted]');
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes(secret));
});

check('an invisible character leaves nothing behind but a gap: it hides no key and glues none to a word', () => {
  const key = `AKIA${'B'.repeat(16)}`;
  for (const invisible of ['\u200B', '\uFEFF', '\u2060', '\u034F', '\uFE0F', '\u{E0041}', '\u{E0100}']) {
    assert.equal(scrub(`from${invisible}${key} failed`, null, []), 'from[redacted] failed', JSON.stringify(invisible));
    assert.equal(scrub(`${key.slice(0, 9)}${invisible}${key.slice(9)} failed`, null, []), '[redacted] failed', JSON.stringify(invisible));
  }
  assert.equal(scrub('a\u200B\u200B\u200Bb', null, []), 'ab');
  assert.equal(scrub('a \u200Bb', null, []), 'a b');
  assert.equal(scrub('\u200B\u202E', null, []), '');
});

check('a whitespace run that holds anything but plain spaces is a gap, and the controls are one space', () => {
  assert.equal(scrub('a\u0000b\u0085c\u2028d\u2029e\u00A0f\u3000g\v\fh', null, []), 'a b c d e f g h');
  assert.equal(scrub('a   b\t\tc', null, []), 'a b c');
  assert.equal(scrub(`key sk-ant-api03-${'A'.repeat(20)}\u3000${'A'.repeat(20)} rejected`, null, []), 'key [redacted] rejected');
});

check('an account identifier is masked: an Amazon resource name whole, and a bare twelve digit number that is not part of a longer one', () => {
  assert.equal(scrub('User: arn:aws:iam::123456789012:role/sre-agent-task is not authorized', null, []), 'User: [redacted] is not authorized');
  assert.equal(scrub('denied arn:aws-us-gov:iam::123456789012:user/ops now', null, []), 'denied [redacted] now');
  assert.equal(scrub('Account 123456789012 is not subscribed', null, []), 'Account [redacted] is not subscribed');
  assert.equal(scrub('request 1234567890123 and 12345678901 and 123e4567-e89b-12d3-a456-426614174000 stay', null, []), 'request 1234567890123 and 12345678901 and 123e4567-e89b-12d3-a456-426614174000 stay');
});

check('a field with a secret in it is masked: a password, a client secret, a percent-encoded query name, an Ocp-Apim key', () => {
  assert.equal(scrub('login failed, password: hunter2xyz for user', null, []), 'login failed, password: [redacted] for user');
  assert.equal(scrub('secret=s3cr3t-value used', null, []), 'secret=[redacted] used');
  assert.equal(scrub('GET /v1/models?x%2Dapi%2Dkey=value123&y=2 failed', null, []), 'GET /v1/models?x%2Dapi%2Dkey=[redacted]&y=2 failed');
  assert.equal(scrub(`Ocp-Apim-Subscription-Key: ${'a'.repeat(32)} was refused`, null, []), 'Ocp-Apim-Subscription-Key: [redacted] was refused');
  assert.equal(scrub('{"type": "authentication_error", "token_type": "bearer_x"}', null, []), '{"type": "authentication_error", "token_type": "bearer_x"}');
});

check('a known key is removed in its base64 forms too, at each of the three alignments, and a key nobody gave is kept', () => {
  const key = 'KEY12345678';
  for (const encoded of ['S0VZMTIzNDU2Nzg=', 'eEtFWTEyMzQ1Njc4', 'eHlLRVkxMjM0NTY3OA==']) {
    assert.equal(scrub(`token ${encoded} rejected`, null, [key]), 'token [redacted] rejected', encoded);
  }
  assert.equal(scrub('credential dXNlcjpLRVkxMjM0NTY3OA== rejected', null, [key]), 'credential dXNl[redacted] rejected');
  assert.equal(scrub('token S0VZMTIzNDU2Nzg= rejected', null, []), 'token S0VZMTIzNDU2Nzg= rejected');
  const urlSafe = Buffer.from(`xy${'k?>>'.repeat(3)}`).toString('base64');
  assert.ok(urlSafe.includes('+') || urlSafe.includes('/'));
  const secret = 'k?>>k?>>k?>>';
  const echoed = Buffer.from(`xy${secret}`).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(scrub(`token ${echoed} rejected`, null, [secret]), 'token [redacted] rejected');
  const accented = 'cl\u00E9-secr\u00E8te-1234';
  assert.equal(scrub(`token ${Buffer.from(accented).toString('base64')} rejected`, null, [accented]), 'token [redacted] rejected');
});

check('a secret holding a control character is removed from its JSON-escaped form, which writes the code in upper case', () => {
  const secret = 'abc\u001Fdef-ghi-jkl';
  assert.equal(scrub('echoed abc\\u001Fdef-ghi-jkl in the body', null, [secret]), 'echoed [redacted] in the body');
  const slashed = 'a/b\\u0061c-0123456789';
  assert.equal(scrub(`echoed ${JSON.stringify(slashed).slice(1, -1)} in the body`, null, [slashed]), 'echoed [redacted] in the body');
});

check('the limit of the output is the caller\'s when it names one', () => {
  const out = scrub('word '.repeat(400), null, [], 1000);
  assert.ok(Buffer.byteLength(out) <= 1000 && Buffer.byteLength(out) > 500);
  assert.equal(scrub('a b', null, []), 'a b');
});

// A hostile shape costs linear work in what is read, and a multi-megabyte body
// costs what its first 64 KiB cost. A wall clock cannot be exact, so each bound
// is far from both the measured cost and the cost of a search per start (the
// quadratic form of the JWT rule took 620 ms at 64 KiB where this takes 2).
const HOSTILE = [
  ['a key prefix with no key', 'sk-ant-'],
  ['a bearer word', 'Bearer '],
  ['a jwt start', 'eyJ'],
  ['a jwt start inside a run', 'eyJa.'],
  ['a jwt start and a line break', 'eyJ\n'],
  ['a jwt start after a space', ' eyJ'],
  ['a jwt start and a dot', 'eyJ.'],
  ['a jwt start and an invisible character', 'eyJ\u200B'],
  ['an arn prefix', 'arn:aws:'],
  ['an arn prefix and a line break', 'arn:aws:\n'],
  ['digits', '1234567890'],
  ['digits and line breaks', '12345\n6789012\n'],
  ['a header name', 'password:'],
  ['a query name', '?token='],
  ['a user in a url', '://a:'],
  ['a run of key characters', 'abcdefghij'],
  ['an access key prefix', 'AKIA'],
  ['line breaks between key characters', 'abcdef\n'],
  ['spaces', ' '],
  ['an escape start', '\x1b['],
  ['a percent escape start', '?api%'],
  ['a percent escape and a line break', '?api%\n5'],
  ['a percent escape and a mark', '?token%\u0301'],
  ['a replacement character', '\uFFFD'],
  ['a replacement character and a word', 'ab\uFFFD'],
  ['a combining mark after an ascii letter', 'a\u0301'],
  ['combining marks after a letter of another script', '\u0438\u0306\u0301'],
  ['a mark and a line break', 'a\u0301\n'],
  ['hex and a dash before digits', 'abcd-1234'],
  ['a uuid prefix and digits', '123e4567-e89b-12d3-a456-4266'],
  ['a long run of hex groups', '1234abcd-'],
  ['digits and a dash', '123456789012-'],
];

function bestMilliseconds(work) {
  let best = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const started = process.hrtime.bigint();
    work();
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return best;
}

function repeated(unit, size) {
  return unit.repeat(Math.max(Math.floor(size / Buffer.byteLength(unit)), 1));
}

check('4 MiB costs what 256 KiB costs, because only the first 64 KiB is read', () => {
  for (const [name, unit] of HOSTILE) {
    const small = bestMilliseconds(() => scrub(repeated(unit, 262144), null, ['gw-secret-key-1']));
    const large = bestMilliseconds(() => scrub(repeated(unit, 4194304), null, ['gw-secret-key-1']));
    assert.ok(large <= 4 * small + 250, `${name}: ${small.toFixed(1)} ms for 256 KiB, ${large.toFixed(1)} ms for 4 MiB`);
    assert.ok(large < 1500, `${name}: ${large.toFixed(1)} ms for 4 MiB`);
  }
});

check('work grows linearly with what is read, up to the read bound', () => {
  for (const [name, unit] of HOSTILE) {
    const small = bestMilliseconds(() => scrub(repeated(unit, 16384), null, []));
    const large = bestMilliseconds(() => scrub(repeated(unit, 65536), null, []));
    assert.ok(large <= 8 * small + 150, `${name}: ${small.toFixed(1)} ms for 16 KiB, ${large.toFixed(1)} ms for 64 KiB`);
  }
});

check('a hostile run of jwt starts is one long run, a start that is no jwt is left alone and one that is is masked from its first start', () => {
  assert.equal(scrub(`${'eyJ\n'.repeat(5000)}x`, null, []), '[redacted]');
  assert.equal(scrub('eyJ.eyJ.eyJ.eyJa.b.c done', null, []), 'eyJ.eyJ.eyJ.[redacted] done');
  assert.equal(scrub('eyJ\neyJ\n x y z done', null, []), 'eyJ eyJ x y z done');
  assert.equal(scrub('eyJ\neyJ\neyJ\na.b.c done', null, []), '[redacted] done');
});

// opencode's own shapes, as the --format json events carry them.
function apiError(statusCode, message, extra = {}) {
  const { name = 'APIError', responseBody, ...rest } = extra;
  return { type: 'error', timestamp: 0, sessionID: 'ses_x', error: { name, data: { message, statusCode, isRetryable: false, ...(responseBody === undefined ? {} : { responseBody }), ...rest } } };
}

function verdict(jsonEvents, run = { exitCode: 1, stopped: false }) {
  const events = [];
  for (const event of jsonEvents) remember(events, event);
  return classify(events, run, {});
}

const ANTHROPIC_CREDIT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const rows = [
  ['ProviderAuthError is auth', { type: 'error', error: { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'User not found.' } } }, 'auth', null, 'User not found.'],
  ['a 401 is auth (Anthropic)', apiError(401, 'invalid x-api-key', { responseBody: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }), 'auth', 401, 'invalid x-api-key'],
  ['a 401 is auth (OpenAI, the key shape is masked)', apiError(401, `Incorrect API key provided: sk-proj-${'a'.repeat(30)}. You can find your API key at https://platform.example/account/api-keys.`, { responseBody: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }) }), 'auth', 401, 'Incorrect API key provided: [redacted]. You can find your API key at https://platform.example/account/api-keys.'],
  ['a 403 is auth (Google)', apiError(403, 'Method doesn\'t allow unregistered callers.', { responseBody: JSON.stringify({ error: { code: 403, message: 'x', status: 'PERMISSION_DENIED' } }) }), 'auth', 403, 'Method doesn\'t allow unregistered callers.'],
  ['a 402 is billing', apiError(402, 'Insufficient credits'), 'billing', 402, 'Insufficient credits'],
  ['a 400 with the credit balance sentence is billing (Anthropic)', apiError(400, ANTHROPIC_CREDIT, { responseBody: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: ANTHROPIC_CREDIT } }) }), 'billing', 400, ANTHROPIC_CREDIT],
  ['a 400 with a billing hard limit is billing (OpenAI)', apiError(400, 'Billing hard limit has been reached', { responseBody: JSON.stringify({ error: { message: 'x', type: 'invalid_request_error', code: 'billing_hard_limit_reached' } }) }), 'billing', 400, 'Billing hard limit has been reached'],
  ['a 400 asking for payment is billing', apiError(400, 'Payment required to continue'), 'billing', 400, 'Payment required to continue'],
  ['a 429 insufficient_quota in the body code is quota (OpenAI)', apiError(429, 'Too many requests', { responseBody: JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }) }), 'quota', 429, 'Too many requests'],
  ['a 429 with the quota sentence is quota', apiError(429, 'You exceeded your current quota, please check your plan and billing details.'), 'quota', 429, 'You exceeded your current quota, please check your plan and billing details.'],
  ['a 429 RESOURCE_EXHAUSTED with Quota exceeded is quota (Google)', apiError(429, 'Quota exceeded for quota metric \'Generate Content API requests per minute\' and limit \'GenerateContent request limit per minute for a project\'', { responseBody: JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }) }), 'quota', 429, 'Quota exceeded for quota metric \'Generate Content API requests per minute\' and limit \'GenerateContent request limit per minute for a project\''],
  ['RESOURCE_EXHAUSTED together with quota is quota', apiError(429, 'RESOURCE_EXHAUSTED: the project has no quota left today'), 'quota', 429, 'RESOURCE_EXHAUSTED: the project has no quota left today'],
  ['a 429 on the free tier is quota', apiError(429, 'You have hit the free tier limit for this model'), 'quota', 429, 'You have hit the free tier limit for this model'],
  ['a plain 429 is rate_limit (Anthropic)', apiError(429, 'This request would exceed your organization\'s rate limit of 50 requests per minute', { responseBody: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } }) }), 'rate_limit', 429, 'This request would exceed your organization\'s rate limit of 50 requests per minute'],
  ['RESOURCE_EXHAUSTED with no quota word is rate_limit', apiError(429, 'RESOURCE_EXHAUSTED: slow down'), 'rate_limit', 429, 'RESOURCE_EXHAUSTED: slow down'],
  ['a 404 is model_not_found (Anthropic)', apiError(404, 'model: claude-nope-1', { responseBody: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope-1' } }) }), 'model_not_found', 404, 'model: claude-nope-1'],
  ['a 404 is model_not_found (Google)', apiError(404, 'models/gemini-nope is not found for API version v1beta'), 'model_not_found', 404, 'models/gemini-nope is not found for API version v1beta'],
  ['a 400 with the model_not_found body code is model_not_found', apiError(400, 'The requested model is unavailable', { responseBody: JSON.stringify({ error: { message: 'x', type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }) }), 'model_not_found', 400, 'The requested model is unavailable'],
  ['a 400 with unknown model is model_not_found', apiError(400, 'Unknown model: gpt-nope'), 'model_not_found', 400, 'Unknown model: gpt-nope'],
  ['a 400 whose model does not exist is model_not_found', apiError(400, 'The model `gpt-nope` does not exist or you do not have access to it.'), 'model_not_found', 400, 'The model `gpt-nope` does not exist or you do not have access to it.'],
  ['a 400 with the not_found_error type is model_not_found', apiError(400, 'bad', { responseBody: JSON.stringify({ error: { type: 'not_found_error' } }) }), 'model_not_found', 400, 'bad'],
  ['a status as a numeric string is read', apiError('402', 'Insufficient credits'), 'billing', 402, 'Insufficient credits'],
  ['the top level code of the body is read', apiError(400, 'bad', { responseBody: JSON.stringify({ code: 'model_not_found' }) }), 'model_not_found', 400, 'bad'],
];
for (const [name, event, klass, status, message] of rows) {
  check(`classified: ${name}`, () => {
    const got = verdict([event]);
    assert.ok(got, 'not classified');
    assert.deepEqual({ class: got.class, status: got.status, message: got.message }, { class: klass, status, message });
    assert.ok(CLASSES.includes(got.class));
  });
}

const GEMINI_KEY = 'API key not valid. Please pass a valid API key.';
check('classified: a 400 that says the key is not valid is auth (Gemini)', () => {
  const got = verdict([apiError(400, GEMINI_KEY, { responseBody: JSON.stringify({ error: { code: 400, message: GEMINI_KEY, status: 'INVALID_ARGUMENT' } }) })]);
  assert.deepEqual({ class: got.class, status: got.status, message: got.message }, { class: 'auth', status: 400, message: GEMINI_KEY });
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { code: 400, status: 'API_KEY_INVALID' } }) })]).class, 'auth');
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { code: 'api_key_invalid' } }) })]).class, 'auth');
});

// A 400 holds up to three signals; one alone decides, two or more is not a refusal.
const SIGNALS = { billing: 'credit balance is too low', model_not_found: 'unknown model gpt-nope', auth: 'API key not valid' };
check('a 400 that carries one signal is that class, and two or three signals are not a refusal', () => {
  const names = Object.keys(SIGNALS);
  for (let mask = 1; mask < 8; mask += 1) {
    const chosen = names.filter((_name, at) => mask & (1 << at));
    const got = verdict([apiError(400, chosen.map((name) => SIGNALS[name]).join('; '))]);
    if (chosen.length === 1) assert.equal(got && got.class, chosen[0], chosen.join('+'));
    else assert.equal(got, null, chosen.join('+'));
  }
});

// A 400 is a missing model only when the body code is a whole token or the
// sentence names the model id right before "does not exist". Each row is the
// platform's (provider_refusal_test.exs), the same words in the same classes.
const MODEL_400_ROWS = [
  ['the sentence with a backquoted id', 'The model `gpt-9` does not exist or you do not have access to it.', 'model_not_found'],
  ['the sentence with a quoted id holding a slash, a colon and a dot', "Model 'acme/llama-3.1:70b' does not exist.", 'model_not_found'],
  ['the sentence with a bare id', 'The model gpt-9 does not exist', 'model_not_found'],
  ['a model line with the code after it', 'model: claude-x-1 not_found_error', 'model_not_found'],
  ['the code as a whole token after a colon', 'error: model_not_found.', 'model_not_found'],
  ['the unknown model phrase', 'Unknown model: claude-x-1', 'model_not_found'],
  ['a parameter that does not exist for this model', "Unsupported parameter for this model: 'temperature' does not exist in the request schema", null],
  ['a field that does not exist (the word model is quoted)', "the field 'model' passed in tool_choice does not exist", null],
  ['a tool field that does not exist', "The field model of the tool 'x' does not exist", null],
  ['this model followed by an id', 'for this model `x` does not exist', null],
  ['no id at all', 'the model does not exist', null],
  ['a long run of words between the two', `The model is fine. ${'x'.repeat(30)} does not exist`, null],
  ['a code with a suffix is not a token', 'model_not_found_in_tools', null],
  ['another code with a suffix', 'not_found_error_in_tools', null],
  ['a code with a prefix is not a token', 'x_model_not_found', null],
  ['a tool schema property that does not exist', "tools.0.custom.input_schema: property 'x' does not exist", null],
];
for (const [name, words, klass] of MODEL_400_ROWS) {
  check(`a 400 missing-model reading: ${name}`, () => {
    const got = verdict([apiError(400, words)]);
    assert.equal(got && got.class, klass, words);
  });
}

check('a 400 body code is read as a whole token, in the body and not as a substring', () => {
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { code: 'model_not_found_in_tools' } }) })]), null);
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { code: 'not_found_error_in_tools' } }) })]), null);
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { code: 'model_not_found' } }) })]).class, 'model_not_found');
  assert.equal(verdict([apiError(400, 'bad', { responseBody: JSON.stringify({ error: { type: 'not_found_error' } }) })]).class, 'model_not_found');
});

check('the missing-model sentence is linear on a hostile run and reads ASCII whitespace only', () => {
  const started = Date.now();
  assert.equal(verdict([apiError(400, `model ${'model '.repeat(700)}x`)]), null);
  assert.equal(verdict([apiError(400, `model ${'a'.repeat(3000)}`)]), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(verdict([apiError(400, 'The model gpt-9 does not exist')]), null);
  assert.equal(verdict([apiError(400, 'The model\tgpt-9\ndoes not exist')]).class, 'model_not_found');
});

// A 403 is auth only with an authentication word and never with a policy or
// safety word. 401 needs no word.
const FORBIDDEN_ROWS = [
  ['an invalid key', 'Invalid API key', 'auth'],
  ['a missing key', 'Missing API key', 'auth'],
  ['the permission word in the type', 'bad', 'auth', JSON.stringify({ error: { type: 'permission_error' } })],
  ['the key lacks permission', 'Your API key does not have permission to use this model', 'auth'],
  ['permission denied in the status', 'The caller is denied', 'auth', JSON.stringify({ error: { status: 'PERMISSION_DENIED' } })],
  ['an authentication error type', 'bad', 'auth', JSON.stringify({ error: { type: 'authentication_error' } })],
  ['unauthorized', 'Unauthorized', 'auth'],
  ['forbidden for this key', 'Forbidden for this key', 'auth'],
  ['forbidden, the account is not allowed', 'Forbidden: the account is not allowed to call this endpoint', 'auth'],
  ['access denied', 'Access denied', 'auth'],
  ['an invalid token', 'invalid token supplied', 'auth'],
  ['a bare forbidden', 'forbidden', null],
  ['an empty body', '', null],
  ['a forbidden with the account word after a full stop', 'Forbidden. The account is fine', null],
  ['a content policy block', 'Request blocked by the content policy of this model', null],
  ['a safety block', 'The prompt was blocked for safety reasons', null],
  ['a content filter code with a permission word', 'no permission to bypass the filter', null, JSON.stringify({ error: { code: 'content_filter' } })],
  ['a usage policy violation naming credentials', 'usage policy violation: credentials were shared', null],
  ['a region that is not supported', 'Country, region, or territory not supported', null],
];
for (const [name, words, klass, body] of FORBIDDEN_ROWS) {
  check(`a 403 reading: ${name}`, () => {
    const got = verdict([apiError(403, words, body === undefined ? {} : { responseBody: body })]);
    assert.equal(got && got.class, klass, words);
  });
}

check('a 401 is auth with no words at all', () => {
  assert.equal(verdict([apiError(401, '')]).class, 'auth');
  assert.equal(verdict([apiError(401, 'no words at all')]).class, 'auth');
});

check('only 401 (and a 403 with an authentication word) is auth, 402 billing, 404 model_not_found, and a 429 is quota only on a quota word', () => {
  const table = [[401, 'auth'], [403, null], [402, 'billing'], [404, 'model_not_found'], [429, 'rate_limit'], [400, null], [408, null], [409, null], [422, null], [500, null], [503, null], [529, null]];
  for (const [status, klass] of table) {
    const got = verdict([apiError(status, 'nothing that names a class')]);
    assert.equal(got && got.class, klass, String(status));
  }
  for (const words of ['insufficient_quota', 'You exceeded your current quota', 'quota exceeded', 'on the free tier', 'RESOURCE_EXHAUSTED: no quota left']) {
    assert.equal(verdict([apiError(429, words)]).class, 'quota', words);
  }
  assert.equal(verdict([apiError(429, 'RESOURCE_EXHAUSTED: slow down')]).class, 'rate_limit');
});

const notRefusals = [
  ['a 500', [apiError(500, 'Internal server error')]],
  ['an overload (529)', [apiError(529, 'Overloaded')]],
  ['a 503', [apiError(503, 'The model is overloaded. Please try again later.')]],
  ['a 408', [apiError(408, 'Request timeout')]],
  ['a 413', [apiError(413, 'request too large')]],
  ['a context overflow', [{ type: 'error', error: { name: 'ContextOverflowError', data: { message: 'prompt is too long' } } }]],
  ['a content filter', [{ type: 'error', error: { name: 'ContentFilterError', data: { message: 'blocked' } } }]],
  ['an abort', [{ type: 'error', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }]],
  ['an unknown error', [{ type: 'error', error: { name: 'UnknownError', data: { message: 'credit balance is too low' } } }]],
  ['a 400 that matches no row', [apiError(400, 'invalid request')]],
  ['a 400 about our own request that says billing, or a thing that does not exist', [apiError(400, 'The billing_address field is required')]],
  ['a 400 whose tool property does not exist', [apiError(400, 'tools.0.custom.input_schema: property \'x\' does not exist')]],
  ['a 400 whose parameter is not supported', [apiError(400, 'this model is not supported for this parameter')]],
  ['a 400 that holds a billing and a model word', [apiError(400, 'credit balance is too low; unknown model')]],
  ['a 402 followed by a 500 as the last event', [apiError(402, 'Insufficient credits'), apiError(500, 'Internal server error')]],
  ['a refusal followed by a plain error', [apiError(401, 'invalid x-api-key'), { type: 'error', error: { name: 'UnknownError', data: { message: 'boom' } } }]],
  ['a 402 with the name of another error', [{ type: 'error', error: { name: 'ProviderError', data: { message: 'x', statusCode: 402 } } }]],
  ['an error with no data', [{ type: 'error', error: { name: 'APIError' } }]],
  ['an error that is a string', [{ type: 'error', error: 'credit balance is too low' }]],
  ['no events at all', []],
];
for (const [name, events] of notRefusals) {
  check(`ambiguous is not a refusal: ${name}`, () => assert.equal(verdict(events), null));
}

check('ambiguous is not a refusal: exit code 0 with a 402 event, a null exit code, and a stopped run with a 402 event', () => {
  const event = apiError(402, 'Insufficient credits');
  assert.equal(verdict([event], { exitCode: 0, stopped: false }), null);
  assert.equal(verdict([event], { exitCode: null, stopped: false }), null);
  assert.equal(verdict([event], { exitCode: undefined, stopped: false }), null);
  assert.equal(verdict([event], { exitCode: 1, stopped: true }), null);
  assert.equal(verdict([event], null), null);
  assert.notEqual(verdict([event], { exitCode: 1, stopped: false }), null);
});

check('the last error event decides, and a refusal after a plain error is a refusal', () => {
  assert.equal(verdict([apiError(500, 'Internal server error'), apiError(402, 'Insufficient credits')]).class, 'billing');
  assert.equal(verdict([{ type: 'text', part: { text: 'hello' } }, apiError(401, 'invalid x-api-key'), { type: 'step_finish' }]).class, 'auth');
});

check('the last 20 events are kept and a message is cut at 2,000 code points before it is read', () => {
  const events = [];
  for (let at = 0; at < 25; at += 1) remember(events, apiError(500, `event ${at}`));
  assert.equal(events.length, EVENTS_MAX);
  assert.equal(events[0].message, 'event 5');
  assert.equal(events[19].message, 'event 24');
  assert.equal(eventFrom({ type: 'text' }), null);
  assert.equal(eventFrom(null), null);
  const long = eventFrom(apiError(402, 'a '.repeat(5000)));
  assert.ok(Array.from(long.message).length <= RAW_MAX_CODE_POINTS);
  assert.ok(Array.from(long.message).length >= RAW_MAX_CODE_POINTS - 2);
  const astral = eventFrom(apiError(402, '\u{1F600} '.repeat(3000)));
  assert.ok(Array.from(astral.message).length <= RAW_MAX_CODE_POINTS);
  const short = eventFrom(apiError(402, 'short'));
  assert.equal(short.message, 'short');
  const open = eventFrom(apiError(402, `${'a '.repeat(996)}sk-ant-${'B'.repeat(200)}`));
  assert.equal(open.message.includes('sk-ant-'), false);
});

check('a body code is read from a JSON responseBody and a body that is not JSON is ignored', () => {
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: JSON.stringify({ error: { code: 'model_not_found' } }) })).bodyCode, 'model_not_found');
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: JSON.stringify({ error: { type: 'not_found_error' } }) })).bodyCode, 'not_found_error');
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: JSON.stringify({ code: 'model_not_found' }) })).bodyCode, 'model_not_found');
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: JSON.stringify({ error: { code: 429 } }) })).bodyCode, null);
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: '<html>502 Bad Gateway model_not_found</html>' })).bodyCode, null);
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: '{"error": "model_not_found"}' })).bodyCode, null);
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: `{"error":{"code":"${'a'.repeat(70000)}"}}` })).bodyCode, null);
  assert.equal(eventFrom(apiError(400, 'x', { responseBody: {} })).bodyCode, null);
  assert.equal(eventFrom(apiError(400, 'x')).bodyCode, null);
});

check('a status outside 100 to 599, or not a whole number, is no status', () => {
  for (const value of [99, 600, 402.5, '4020', 'abc', null, undefined, {}]) assert.equal(eventFrom(apiError(value, 'x')).statusCode, null, String(value));
  assert.equal(eventFrom(apiError(402, 'x')).statusCode, 402);
});

check('the provider id and the name are kept as read, and an event with no message has none', () => {
  const event = eventFrom({ type: 'error', error: { name: 'ProviderAuthError', data: { providerID: 'anthropic' } } });
  assert.deepEqual({ name: event.name, providerID: event.providerID, message: event.message }, { name: 'ProviderAuthError', providerID: 'anthropic', message: '' });
  assert.equal(classify([event], { exitCode: 1, stopped: false }).message, null);
});

check('the words are scrubbed in the verdict, through the runner\'s redact function and the secrets it holds', () => {
  const secret = 'provider-secret-value-9876';
  const events = remember([], apiError(401, `Invalid API key: ${secret}\nretry with ${secret.slice(0, 12)}\n${secret.slice(12)} and ${secret.slice(0, 12)} alone`));
  const got = classify(events, { exitCode: 1, stopped: false }, { redact: redactWith([secret]), secrets: [secret] });
  assert.equal(got.message, 'Invalid API key: [redacted] retry with [redacted] and provider-sec alone');
});

check('every variable the runner can be given a provider key in is on its secret list and is removed from a message', () => {
  const listed = spawnSync('bash', [path.join(root, 'scripts', 'provider_env.sh'), '--all'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(listed.length >= 19);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-refusal-'));
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    const keys = {};
    listed.forEach((name, at) => {
      keys[name] = `value-of-${name.toLowerCase()}-${String(at).padStart(3, '0')}-${'z'.repeat(12)}`;
      process.env[name] = keys[name];
    });
    Object.assign(process.env, { PATH: saved.PATH, HOME: work, SRE_SERVER_URL: 'http://127.0.0.1:9', SRE_API_KEY: `sre-agent-poll-${'1'.repeat(48)}`, SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro', SRE_WORKSPACE: path.join(work, 'ws'), SRE_ONCE: '1' });
    fs.mkdirSync(process.env.SRE_WORKSPACE, { recursive: true });
    const runner = require(path.join(root, 'runner', 'runner.js'));
    assert.deepEqual([...runner.PROVIDER_KEY_VARIABLES].sort(), [...listed].sort());
    runner.loadConfig();
    for (const name of listed) {
      const events = remember([], apiError(401, `rejected ${keys[name]} for the account`));
      const got = classify(events, { exitCode: 1, stopped: false }, { redact: runner.internals.redact, secrets: runner.internals.heldSecrets() });
      assert.equal(got.message, 'rejected [redacted] for the account', name);
    }
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

check('the runner\'s redact() ignores a held value of fewer than eight bytes, and removes one of eight', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-refusal-short-'));
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, { PATH: saved.PATH, HOME: work, SRE_SERVER_URL: 'http://127.0.0.1:9', SRE_API_KEY: `sre-agent-poll-${'2'.repeat(48)}`, SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro', SRE_WORKSPACE: path.join(work, 'ws'), SRE_ONCE: '1', OPENROUTER_API_KEY: 'none' });
    fs.mkdirSync(process.env.SRE_WORKSPACE, { recursive: true });
    const runner = require(path.join(root, 'runner', 'runner.js'));
    runner.loadConfig();
    const { redact, heldSecrets } = runner.internals;
    assert.ok(heldSecrets().includes(`sre-agent-poll-${'2'.repeat(48)}`));
    assert.equal(heldSecrets().includes('none'), false);
    assert.equal(redact('none of the models answered'), 'none of the models answered');
    assert.equal(redact(`key sre-agent-poll-${'2'.repeat(48)} rejected`), 'key [redacted] rejected');
    runner.internals.addRotatingSecret('abcdefg');
    runner.internals.addRotatingSecret('abcdefgh');
    assert.equal(redact('abcdefg and abcdefgh'), 'abcdefg and [redacted]');
    assert.equal(redact('ééé and éééé'), 'ééé and éééé');
    runner.internals.addRotatingSecret('éééé');
    assert.equal(redact('ééé and éééé'), 'ééé and [redacted]');
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

check('the end of a text is cut by bytes on a character', () => {
  const { cutBytesFromEnd } = require(path.join(root, 'runner', 'provider_refusal.js'));
  assert.equal(cutBytesFromEnd('short', 1000), 'short');
  assert.equal(cutBytesFromEnd('abcdef', 3), 'def');
  assert.equal(cutBytesFromEnd('aéé', 3), 'é');
  assert.equal(cutBytesFromEnd('€€', 4), '€');
  assert.equal(cutBytesFromEnd('x'.repeat(2000), 1000).length, 1000);
  assert.equal(cutBytesFromEnd('', 10), '');
});

check('the follow-up scrubber rules, one by one', () => {
  const key = `sk-ant-api03-${'A'.repeat(40)}`;
  assert.equal(scrub('GET /v1?api%\n5Fkey=secretvalue1 failed', null, []), 'GET /v1?api% 5Fkey=[redacted] failed');
  assert.equal(scrub('GET /v1?api%5\nFkey=secretvalue1 failed', null, []), 'GET /v1?api%5 Fkey=[redacted] failed');
  assert.equal(scrub('GET /v1?x%2\nDapi%2Dkey=secretvalue1 failed', null, []), 'GET /v1?x%2 Dapi%2Dkey=[redacted] failed');
  assert.equal(scrub(`word�${key} rejected`, null, []), 'word[redacted] rejected');
  assert.equal(scrub(`key ${key.slice(0, 20)}�${key.slice(20)} rejected`, null, []), 'key [redacted] rejected');
  assert.equal(scrub('�', null, []), '');
  assert.equal(scrub(`key ${key.slice(0, 20)}́${key.slice(20)} rejected`, null, []), 'key [redacted] rejected');
  assert.equal(scrub('crédito agotado', null, []), 'credito agotado');
  assert.equal(scrub('й kept', null, []), 'й kept');
  assert.equal(scrub('id abcd-123456789012 failed', null, []), 'id abcd-[redacted] failed');
  assert.equal(scrub('id 1234-123456789012 failed', null, []), 'id 1234-[redacted] failed');
  assert.equal(scrub('id 123e4567-e89b-12d3-a456-123456789012 stays', null, []), 'id 123e4567-e89b-12d3-a456-123456789012 stays');
  assert.equal(scrub('id 123E4567-E89B-12D3-A456-123456789012 stays', null, []), 'id 123E4567-E89B-12D3-A456-123456789012 stays');
});

check('a lone surrogate leaves nothing of the key it split, and the output is well formed', () => {
  const lone = JSON.parse('"sk-ant-api03-abcdefghij\\ud800klmnopqrstuvwxyz0123 and AKIAIOSFOD\\udc00NN7EXAMPLE"');
  assert.equal(lone.isWellFormed(), false);
  const out = scrub(lone, null, []);
  assert.equal(out, '[redacted] and [redacted]');
  assert.equal(out.isWellFormed(), true);
  for (const piece of ['abcdefghij', 'klmnopqrst', 'AKIAIOSF', 'NN7EXAMPLE']) assert.equal(out.includes(piece), false, piece);
  assert.equal(scrub('\ud800', null, []), '');
  assert.equal(scrub('a\udc00b', null, []), 'ab');
  assert.equal(scrub('smile 😀 ok', null, []), 'smile 😀 ok');
});

check('a lone surrogate in an error event is a replacement character before anything reads it, and the verdict serialises with no surrogate escape', () => {
  assert.equal(wellFormed('x\ud800y\udc00z'), 'x�y�z');
  assert.equal(wellFormed('😀'), '😀');
  const event = eventFrom({ type: 'error', error: { name: 'APIError\ud800', data: { statusCode: 401, message: 'bad key sk-ant-api03-abcdefghij\ud800klmnopqrstuvwxyz0123', providerID: 'p\udc00', responseBody: '{"error":{"code":"x\ud800"}}' } } });
  assert.equal(event.message.isWellFormed(), true);
  assert.equal(event.name.isWellFormed(), true);
  assert.equal(event.providerID.isWellFormed(), true);
  const string = eventFrom({ type: 'error', error: 'oops\ud800' });
  assert.equal(string.message, 'oops�');
  const got = classify(remember([], { type: 'error', error: { name: 'APIError', data: { statusCode: 401, message: 'bad key sk-ant-api03-abcdefghij\ud800klmnopqrstuvwxyz0123 \udc00' } } }), { exitCode: 1, stopped: false });
  assert.equal(got.class, 'auth');
  const json = JSON.stringify(got);
  assert.equal(/\\ud[89a-f][0-9a-f]{2}/i.test(json), false, json);
  assert.equal(got.message, 'bad key [redacted]');
});

check('a short held value with a digit or punctuation (LiteLLM\'s default master key) is still removed; an all-letter one is not', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-refusal-litellm-'));
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, { PATH: saved.PATH, HOME: work, SRE_SERVER_URL: 'http://127.0.0.1:9', SRE_API_KEY: `sre-agent-poll-${'3'.repeat(48)}`, SRE_MODEL: 'litellm/gpt-4o', SRE_WORKSPACE: path.join(work, 'ws'), SRE_ONCE: '1', OPENROUTER_API_KEY: 'sk-1234' });
    fs.mkdirSync(process.env.SRE_WORKSPACE, { recursive: true });
    const runner = require(path.join(root, 'runner', 'runner.js'));
    runner.loadConfig();
    const { redact, heldSecrets, addRotatingSecret } = runner.internals;
    assert.ok(heldSecrets().includes('sk-1234'));
    assert.equal(redact('the gateway rejected sk-1234 for this model'), 'the gateway rejected [redacted] for this model');
    const scrubbed = scrub('Authentication failed for sk-1234, retry', redact, heldSecrets());
    assert.equal(scrubbed, 'Authentication failed for [redacted], retry');
    const refusal = classify(remember([], apiError(401, 'rejected sk-1234 for this account')), { exitCode: 1, stopped: false }, { redact, secrets: heldSecrets() });
    assert.equal(refusal.message, 'rejected [redacted] for this account');
    for (const short of ['p4ss', 'ab_cd', 'k-1', '1234567', 'ééé1']) {
      addRotatingSecret(short);
      assert.ok(heldSecrets().includes(short), short);
      assert.equal(redact(`x ${short} y`), 'x [redacted] y', short);
    }
    for (const placeholder of ['none', 'EMPTY', 'dummy', 'abcdefg', 'ééé']) {
      addRotatingSecret(placeholder);
      assert.equal(heldSecrets().includes(placeholder), false, placeholder);
      assert.equal(redact(`${placeholder} of the words`), `${placeholder} of the words`, placeholder);
    }
    addRotatingSecret('');
    addRotatingSecret('  ');
    assert.equal(redact('a b  c'), 'a b  c');
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
