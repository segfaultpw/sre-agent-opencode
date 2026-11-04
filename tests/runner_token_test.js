'use strict';
// The runner token: an expiring stand-in for SRE_API_KEY. The runner exchanges
// the key before its first poll, renews the token at 70% of its life, falls
// back to the key when the platform has no exchange, exchanges again from the
// key when the queue stops accepting a token, and stops with a sentence when a
// token-only start has nothing left to renew with. The platform is the queue
// fixture with its token routes switched on.
// Run with `node tests/runner_token_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const runnerPath = path.resolve(__dirname, '..', 'runner', 'runner.js');
const fixturePath = path.resolve(__dirname, 'fixture', 'queue_server.js');

// Assembled at run time, like the other suites: a key shaped literal in the
// repository trips push protection.
const KEY = `sre-agent-poll-${'1'.repeat(48)}`;
const MODEL = 'openrouter/deepseek/deepseek-v4-pro';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-token-test-'));
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
// The renewal point is never sooner than 30 seconds after the last (no loop on
// the exchange); the cases with a few seconds of life lower it, and one case
// proves the floor.
let minRenewMs = 0;

async function startFixture(extraEnv = {}) {
  counter += 1;
  const dir = path.join(work, `fixture-${counter}`);
  fs.mkdirSync(dir);
  const portFile = path.join(dir, 'port');
  const logFile = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const child = spawn(process.execPath, [fixturePath], {
    env: { ...process.env, FIXTURE_PORT_FILE: portFile, FIXTURE_LOG: logFile, FIXTURE_API_KEY: KEY, ...extraEnv },
    stdio: 'ignore',
  });
  for (let waited = 0; !fs.existsSync(portFile) || fs.readFileSync(portFile, 'utf8') === ''; waited += 1) {
    if (waited > 200) throw new Error('the fixture did not start');
    await sleep(25);
  }
  const url = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8')}`;
  return {
    url,
    dir,
    requests: () =>
      fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    stop: () => child.kill('SIGTERM'),
  };
}

function exchanges(fixture) {
  return fixture.requests().filter((entry) => entry.method === 'POST' && /\/token$/.test(entry.path));
}

function queueCalls(fixture) {
  return fixture.requests().filter((entry) => entry.path === '/api/fix-runner/queue');
}

function runnerEnv(fixture, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: work,
    SRE_SERVER_URL: fixture.url,
    SRE_API_KEY: KEY,
    SRE_MODEL: MODEL,
    SRE_WORKSPACE: path.join(work, `workspace-${counter}`),
    ...overrides,
  };
}

// One pass of the real runner against the fixture: an empty queue, so it polls
// once and exits.
function runOnce(fixture, overrides = {}) {
  fs.mkdirSync(path.join(work, `workspace-${counter}`), { recursive: true });
  const result = spawnSync(process.execPath, [runnerPath], {
    env: { ...runnerEnv(fixture, overrides), SRE_ONCE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

// The runner loaded in this process, with the log captured.
function loadRunner(fixture, overrides = {}) {
  fs.mkdirSync(path.join(work, `workspace-${counter}`), { recursive: true });
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, runnerEnv(fixture, overrides));
  delete require.cache[runnerPath];
  const runner = require(runnerPath);
  runner.internals.setTokenMinRenewMs(minRenewMs);
  const config = runner.loadConfig();
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved);
  return { runner, config };
}

function captureOutput() {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return {
    lines,
    restore() {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    },
  };
}

// The platform's mint, called by hand: how a scaler would hand a host a token.
function mintByHand(fixture) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${fixture.url}/api/fix_runner/token`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  // The renewal point is never sooner than 30 seconds after the last (no loop on
  // the exchange); the cases with a few seconds of life lower it, and one case
  // below proves the floor.
  await check('a start with the key exchanges it before the first poll and polls with the token', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000' });
    try {
      const { code, output } = runOnce(fixture);
      assert.equal(code, 0, output);
      const calls = exchanges(fixture);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].authorization, `Bearer ${KEY}`);
      assert.equal(calls[0].path, '/api/fix_runner/token');
      const queue = queueCalls(fixture);
      assert.equal(queue.length, 1);
      assert.match(queue[0].authorization, /^Bearer sre_frt_/);
      assert.notEqual(queue[0].authorization, `Bearer ${KEY}`);
    } finally {
      fixture.stop();
    }
  });

  await check('the key and the token appear in no log line of the runner', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000' });
    try {
      const { output } = runOnce(fixture);
      const token = queueCalls(fixture)[0].authorization.replace('Bearer ', '');
      assert.ok(output.includes('expiring token'), output);
      assert.equal(output.includes(KEY), false);
      assert.equal(output.includes(token), false);
    } finally {
      fixture.stop();
    }
  });

  await check('a platform that spells the route with a hyphen is found', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_ROUTE: 'hyphen' });
    try {
      const { code, output } = runOnce(fixture);
      assert.equal(code, 0, output);
      assert.match(queueCalls(fixture)[0].authorization, /^Bearer sre_frt_/);
    } finally {
      fixture.stop();
    }
  });

  await check('a platform without the exchange (404) is polled with the key, as before', async () => {
    const fixture = await startFixture();
    try {
      const { code, output } = runOnce(fixture);
      assert.equal(code, 0, output);
      const queue = queueCalls(fixture);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].authorization, `Bearer ${KEY}`);
      assert.ok(output.includes('uses SRE_API_KEY as before'), output);
    } finally {
      fixture.stop();
    }
  });

  await check('a platform whose exchange fails (503) is polled with the key meanwhile', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_STATUS: '503' });
    try {
      const { code, output } = runOnce(fixture);
      assert.equal(code, 0, output);
      assert.equal(queueCalls(fixture)[0].authorization, `Bearer ${KEY}`);
      assert.ok(output.includes('using SRE_API_KEY meanwhile'), output);
    } finally {
      fixture.stop();
    }
  });

  await check('a revoked key is the old refusal, naming SRE_API_KEY', async () => {
    const revoke = path.join(work, 'revoke-1');
    fs.writeFileSync(revoke, '');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_REVOKE_FILE: revoke });
    try {
      const refused = runOnce(fixture);
      assert.notEqual(refused.code, 0);
      assert.ok(refused.output.includes('the queue refused SRE_API_KEY with HTTP 401'), refused.output);
    } finally {
      fixture.stop();
    }
  });

  await check('the token is renewed at 70% of its life without a poll, and the old one is not reused', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '4000' });
    const output = captureOutput();
    try {
      const { runner } = loadRunner(fixture);
      const first = await runner.internals.apiCredential();
      assert.match(first, /^sre_frt_/);
      assert.equal(exchanges(fixture).length, 1);
      await sleep(3600);
      const second = await runner.internals.apiCredential();
      assert.notEqual(second, first);
      const calls = exchanges(fixture);
      assert.equal(calls.length, 2, 'the timer renewed once, and the later call found a fresh token');
      assert.equal(calls[1].authorization, `Bearer ${KEY}`, 'a start with the key mints again from the key');
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a token-only start renews with the token it holds, and never needs the key', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '4000' });
    const output = captureOutput();
    try {
      const minted = await mintByHand(fixture);
      const { runner } = loadRunner(fixture, { SRE_API_KEY: minted.token });
      const first = await runner.internals.apiCredential();
      const renewals = exchanges(fixture);
      assert.equal(renewals.length, 2, 'the first use renews the token it was given, which also tells the runner its expiry');
      assert.equal(renewals[1].authorization, `Bearer ${minted.token}`);
      assert.notEqual(first, minted.token);
      assert.equal(fixture.requests().some((entry) => entry.authorization === `Bearer ${KEY}` && entry.path !== '/api/fix_runner/token'), false);
      await sleep(3600);
      const later = await runner.internals.apiCredential();
      assert.notEqual(later, first);
      assert.equal(exchanges(fixture).length >= 3, true);
      assert.equal(exchanges(fixture)[2].authorization, `Bearer ${first}`);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a token-only start stops with its sentence when the token reaches its cap', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '1500', FIXTURE_TOKEN_CAP_MS: '2500' });
    const output = captureOutput();
    try {
      const minted = await mintByHand(fixture);
      const { runner } = loadRunner(fixture, { SRE_API_KEY: minted.token });
      const held = await runner.internals.apiCredential();
      assert.match(held, /^sre_frt_/);
      await sleep(2600);
      let thrown = null;
      try {
        await runner.internals.apiCredential();
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, 'the capped token was still handed out after its cap');
      assert.equal(thrown.fatal, true);
      assert.match(thrown.message, /24 hour cap/);
      assert.match(thrown.message, /SRE_API_KEY/);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a token-only start with a token the platform refuses stops at once with the sentence', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000' });
    try {
      const result = runOnce(fixture, { SRE_API_KEY: 'sre_frt_not-a-token-of-this-platform' });
      assert.notEqual(result.code, 0);
      assert.ok(result.output.includes('refused the runner token'), result.output);
      assert.equal(result.output.includes('sre_frt_not-a-token'), false);
      assert.equal(queueCalls(fixture).length, 0, 'nothing was polled with a token the exchange refused');
    } finally {
      fixture.stop();
    }
  });

  await check('a queue that stops accepting the token gets one fresh exchange from the key', async () => {
    const forget = path.join(work, 'forget-1');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_FORGET_FILE: forget });
    const output = captureOutput();
    try {
      const { runner, config } = loadRunner(fixture);
      const first = await runner.internals.apiCredential();
      fs.writeFileSync(forget, '');
      const answer = await runner.internals.poll(config);
      assert.deepEqual(answer.jobs, []);
      const queue = queueCalls(fixture);
      assert.equal(queue.length, 2);
      assert.equal(queue[0].authorization, `Bearer ${first}`);
      assert.notEqual(queue[1].authorization, `Bearer ${first}`);
      assert.match(queue[1].authorization, /^Bearer sre_frt_/);
      const calls = exchanges(fixture);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].authorization, `Bearer ${KEY}`);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a queue that refuses the token while the exchange is gone (404, a platform rolled back) is polled with the key', async () => {
    const forget = path.join(work, 'forget-3');
    const status = path.join(work, 'status-3');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_FORGET_FILE: forget, FIXTURE_TOKEN_STATUS_FILE: status });
    const output = captureOutput();
    try {
      const { runner, config } = loadRunner(fixture);
      await runner.internals.apiCredential();
      fs.writeFileSync(forget, '');
      fs.writeFileSync(status, '404');
      const answer = await runner.internals.poll(config);
      assert.deepEqual(answer.jobs, []);
      const queue = queueCalls(fixture);
      assert.match(queue[0].authorization, /^Bearer sre_frt_/);
      assert.equal(queue[queue.length - 1].authorization, `Bearer ${KEY}`, 'the retry used the key');
      assert.equal(queue.length, 2);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a queue that refuses the token while the exchange fails (503) is polled with the key, not stopped', async () => {
    const forget = path.join(work, 'forget-4');
    const status = path.join(work, 'status-4');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_FORGET_FILE: forget, FIXTURE_TOKEN_STATUS_FILE: status });
    const output = captureOutput();
    try {
      const { runner, config } = loadRunner(fixture);
      await runner.internals.apiCredential();
      fs.writeFileSync(forget, '');
      fs.writeFileSync(status, '503');
      const answer = await runner.internals.poll(config);
      assert.deepEqual(answer.jobs, []);
      assert.equal(queueCalls(fixture).at(-1).authorization, `Bearer ${KEY}`);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('only the key being refused stops a runner that holds it, with the sentence about the key', async () => {
    const revoke = path.join(work, 'revoke-2');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_REVOKE_FILE: revoke });
    const output = captureOutput();
    try {
      const { runner, config } = loadRunner(fixture);
      await runner.internals.apiCredential();
      fs.writeFileSync(revoke, '');
      let thrown = null;
      try {
        await runner.internals.poll(config);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown && thrown.fatal);
      assert.match(thrown.message, /the queue refused SRE_API_KEY with HTTP 401/);
    } finally {
      output.restore();
      fixture.stop();
    }
  });

  await check('a token that lives no time does not make the runner loop on the exchange', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '1' });
    const output = captureOutput();
    try {
      minRenewMs = 30_000;
      const { runner } = loadRunner(fixture);
      await runner.internals.apiCredential();
      await sleep(1500);
      assert.equal(exchanges(fixture).length, 1, 'renewal came sooner than the floor');
    } finally {
      minRenewMs = 0;
      output.restore();
      fixture.stop();
    }
  });

  await check('only the most recent rotating secrets are kept for the redaction, the constant ones stay', async () => {
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000' });
    try {
      const { runner } = loadRunner(fixture);
      const { internals } = runner;
      for (let n = 0; n < 30; n += 1) internals.addRotatingSecret(`rotating-secret-value-${String(n).padStart(2, '0')}`);
      internals.addRotatingSecret('rotating-secret-value-29');
      const text = Array.from({ length: 30 }, (_, n) => `rotating-secret-value-${String(n).padStart(2, '0')}`).join(' ');
      const out = internals.redact(`${text} ${KEY}`);
      assert.ok(out.includes('rotating-secret-value-09'), 'an old one was dropped from the list');
      assert.equal(out.includes('rotating-secret-value-10'), false);
      assert.equal(out.includes('rotating-secret-value-29'), false);
      assert.equal(out.includes(KEY), false, 'the key stays redacted');
    } finally {
      fixture.stop();
    }
  });

  await check('a token-only start whose token the queue stops accepting stops with the sentence', async () => {
    const forget = path.join(work, 'forget-2');
    const fixture = await startFixture({ FIXTURE_TOKEN_LIFETIME_MS: '600000', FIXTURE_TOKEN_FORGET_FILE: forget });
    const output = captureOutput();
    try {
      const minted = await mintByHand(fixture);
      const { runner, config } = loadRunner(fixture, { SRE_API_KEY: minted.token });
      await runner.internals.apiCredential();
      fs.writeFileSync(forget, '');
      let thrown = null;
      try {
        await runner.internals.poll(config);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, 'poll did not fail');
      assert.equal(thrown.fatal, true);
      assert.match(thrown.message, /refused the runner token/);
      assert.equal(thrown.message.includes(minted.token), false);
    } finally {
      output.restore();
      fixture.stop();
    }
  });
}

main()
  .catch((error) => {
    failed += 1;
    console.log(`FAIL ${error.stack}`);
  })
  .finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
