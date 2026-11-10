'use strict';
// How poll() reads the queue's answers: a 400 naming invalid_instance stops the
// runner, any other 400 (an empty body from a proxy, text, another code) is
// retried like every transient answer, and a 200 after a 400 carries on.
// Run with `node tests/poll_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const runnerPath = path.resolve(__dirname, '..', 'runner', 'runner.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
// Assembled at run time: a key shaped literal in the repository trips push protection.
const KEY = `sre-agent-poll-${'1'.repeat(48)}`;

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

// A queue that answers with a scripted list of {status, body}, the last one
// repeating, and records every request to the queue. Every other path (the
// token exchange the runner tries first) answers 404, the answer of a platform
// that has no exchange, after which the runner polls with the key itself.
function queue(answers) {
  const seen = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url !== '/api/fix-runner/queue') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      seen.push(request.url);
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(answer.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

// The runner as production loads it: loadConfig sets the credential poll() reads.
let loaded = 0;
function load(serverUrl) {
  loaded += 1;
  const workspace = path.join(work, `workspace-${loaded}`);
  fs.mkdirSync(workspace, { recursive: true });
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    PATH: saved.PATH,
    HOME: work,
    SRE_SERVER_URL: serverUrl,
    SRE_API_KEY: KEY,
    SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro',
    SRE_WORKSPACE: workspace,
    SRE_RUNNER_INSTANCE: 'runner-1',
    SRE_ONCE: '1',
  });
  try {
    delete require.cache[runnerPath];
    const runner = require(runnerPath);
    return { poll: runner.internals.poll, config: runner.loadConfig() };
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

function pollOnce(serverUrl) {
  const { poll, config } = load(serverUrl);
  return poll(config);
}

const INVALID = JSON.stringify({ error: 'invalid_instance', message: 'the poll body\'s instance must be absent or a printable string of 1 to 100 bytes' });
const EMPTY_QUEUE = JSON.stringify({ data: [], heartbeat_seconds: 30 });

async function main() {
  await check('a 400 naming invalid_instance stops the runner at once, naming SRE_RUNNER_INSTANCE, the instance name and the 100 byte bound', async () => {
    const platform = await queue([{ status: 400, body: INVALID }, { status: 200, body: EMPTY_QUEUE }]);
    try {
      const started = Date.now();
      await assert.rejects(pollOnce(platform.url), (error) => {
        assert.equal(error.fatal, true);
        assert.match(error.message, /SRE_RUNNER_INSTANCE/);
        assert.match(error.message, /string of at most 100 bytes/);
        assert.match(error.message, /invalid_instance/);
        assert.match(error.message, /"runner-1"/);
        return true;
      });
      assert.equal(platform.seen.length, 1, 'the poll was not retried');
      assert.ok(Date.now() - started < 900, 'no backoff was waited out');
    } finally {
      platform.close();
    }
  });

  await check('invalid_instance is also read from an error object that carries the code', async () => {
    const platform = await queue([{ status: 400, body: JSON.stringify({ error: { code: 'invalid_instance' } }) }]);
    try {
      await assert.rejects(pollOnce(platform.url), (error) => error.fatal === true);
      assert.equal(platform.seen.length, 1);
    } finally {
      platform.close();
    }
  });

  await check('an empty 400 is transient: it is retried and a 200 after it is served', async () => {
    const platform = await queue([{ status: 400, body: '' }, { status: 200, body: EMPTY_QUEUE }]);
    try {
      const answer = await pollOnce(platform.url);
      assert.deepEqual(answer, { jobs: [], heartbeatSeconds: 30 });
      assert.equal(platform.seen.length, 2);
    } finally {
      platform.close();
    }
  });

  await check('a 400 that is not JSON, or names another code, is transient too', async () => {
    const platform = await queue([
      { status: 400, body: '<html>Bad Request</html>' },
      { status: 400, body: JSON.stringify({ error: 'something_else' }) },
      { status: 200, body: EMPTY_QUEUE },
    ]);
    try {
      const answer = await pollOnce(platform.url);
      assert.deepEqual(answer, { jobs: [], heartbeatSeconds: 30 });
      assert.equal(platform.seen.length, 3);
    } finally {
      platform.close();
    }
  });

  await check('a 200 that follows a 400 hands its jobs to the loop', async () => {
    const job = { handoff_id: 'h-1', kind: 'remediation_request' };
    const platform = await queue([{ status: 400, body: '' }, { status: 200, body: JSON.stringify({ data: [job] }) }]);
    try {
      const answer = await pollOnce(platform.url);
      assert.deepEqual(answer.jobs, [job]);
    } finally {
      platform.close();
    }
  });

  if (failed > 0) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main();
