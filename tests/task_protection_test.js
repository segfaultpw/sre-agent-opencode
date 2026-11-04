'use strict';
// ECS task scale-in protection: on while a request is held, off when none is,
// counted across the workers of one task, skipped quietly where it does not
// exist or is not allowed, and never a reason for a request to fail. The
// request lifecycle around it (success, failure, take-over, two real workers)
// is in tests/runner_test.sh. A stub ECS agent stands in for the endpoint.
// Run with `node tests/task_protection_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runner = require(path.resolve(__dirname, '..', 'runner', 'runner.js'));
const { internals } = runner;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'task-protection-test-'));
let failed = 0;
let counter = 0;

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

// An ECS agent that answers every call with `answer()` and records them.
function agent(answer = () => ({ status: 200, body: { protection: { enabled: true } } })) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: request.method, path: request.url, body: raw ? JSON.parse(raw) : null });
      const reply = answer(calls.length);
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ calls, uri: `http://127.0.0.1:${server.address().port}/api/task-0001`, close: () => server.close() }))
  );
}

const DENIED = { status: 400, body: { failure: { reason: 'x' }, error: { Code: 'AccessDeniedException', Message: 'not authorized to perform ecs:UpdateTaskProtection' } } };

function load(env = {}) {
  counter += 1;
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    PATH: saved.PATH,
    HOME: work,
    SRE_SERVER_URL: 'http://127.0.0.1:9',
    SRE_API_KEY: 'sre-agent-poll-protection-test-key-00000000000000000',
    SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro',
    SRE_WORKSPACE: path.join(work, `ws-${counter}`),
    ...env,
  });
  try {
    return runner.loadConfig();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

function capture() {
  const lines = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  return {
    lines,
    stop() {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

async function main() {
  await check('a held request turns protection on for an hour, and releasing it turns it off', async () => {
    const ecs = await agent();
    try {
      load({ ECS_AGENT_URI: ecs.uri });
      await internals.protection.hold('h-1');
      assert.deepEqual(ecs.calls, [{ method: 'PUT', path: '/api/task-0001/task-protection/v1/state', body: { ProtectionEnabled: true, ExpiresInMinutes: 60 } }]);
      await internals.protection.release('h-1');
      assert.equal(ecs.calls.length, 2);
      assert.deepEqual(ecs.calls[1].body, { ProtectionEnabled: false });
    } finally {
      ecs.close();
    }
  });

  await check('serveJob holds protection around a request that fails and lifts it after', async () => {
    const ecs = await agent();
    const output = capture();
    try {
      const config = load({ ECS_AGENT_URI: ecs.uri });
      await runner.startMemory(config);
      await runner.serveJob(config, { handoff_id: 'h-bad' });
      output.stop();
      assert.deepEqual(ecs.calls.map((call) => call.body.ProtectionEnabled), [true, false]);
    } finally {
      output.stop();
      ecs.close();
    }
  });

  await check('with no ECS_AGENT_URI nothing is called, and a debug line says why once', async () => {
    const ecs = await agent();
    const output = capture();
    try {
      load({});
      await internals.protection.hold('h-1');
      await internals.protection.release('h-1');
      await internals.protection.hold('h-2');
      output.stop();
      assert.equal(ecs.calls.length, 0);
      assert.equal(output.lines.join('').includes('not available'), false, 'no info or warn line when it is simply not ECS');
    } finally {
      output.stop();
      ecs.close();
    }
  });

  await check('SRE_TASK_PROTECTION=off calls nothing even on ECS, and a bad value refuses the start', async () => {
    const ecs = await agent();
    try {
      load({ ECS_AGENT_URI: ecs.uri, SRE_TASK_PROTECTION: 'off' });
      await internals.protection.hold('h-1');
      await internals.protection.release('h-1');
      assert.equal(ecs.calls.length, 0);
      assert.throws(() => load({ SRE_TASK_PROTECTION: 'maybe' }), /SRE_TASK_PROTECTION must be auto, on or off/);
    } finally {
      ecs.close();
    }
  });

  for (const [label, denial] of [
    ['400 AccessDeniedException', DENIED],
    ['403', { status: 403, body: { message: 'forbidden' } }],
  ]) {
    await check(`an AccessDenied (${label}) is one info line, then protection is off for the process and no request fails`, async () => {
      const ecs = await agent(() => denial);
      const output = capture();
      try {
        const config = load({ ECS_AGENT_URI: ecs.uri });
        await runner.startMemory(config);
        output.lines.length = 0;
        await runner.serveJob(config, { handoff_id: 'h-denied-1' });
        await runner.serveJob(config, { handoff_id: 'h-denied-2' });
        await internals.protection.hold('h-3');
        await internals.protection.release('h-3');
        output.stop();
        assert.equal(ecs.calls.length, 1, 'the endpoint is not asked again');
        const mine = output.lines.join('').split('\n').filter((line) => /protection/i.test(line));
        assert.equal(mine.length, 1, mine.join('\n'));
        assert.match(mine[0], / info /);
        assert.match(mine[0], /not available to this task/);
        assert.ok(output.lines.join('').includes('skipping it'), 'the requests themselves were handled as before');
      } finally {
        output.stop();
        ecs.close();
      }
    });
  }

  await check('another failure (a 500, then no answer) is a warning, never a failed request, and the next request tries again', async () => {
    const ecs = await agent((n) => (n === 1 ? { status: 500, body: { error: 'down' } } : { status: 200, body: {} }));
    const output = capture();
    try {
      load({ ECS_AGENT_URI: ecs.uri });
      await internals.protection.hold('h-1');
      output.stop();
      assert.match(output.lines.join(''), /warn .*task protection on was not set \(HTTP 500\)/);
      await internals.protection.release('h-1');
      await internals.protection.hold('h-2');
      assert.ok(ecs.calls.length >= 3);
      ecs.close();
      await internals.protection.release('h-2');
    } finally {
      output.stop();
    }
  });

  await check('workers of one task share the protection: it stays on until the last one releases', async () => {
    const ecs = await agent();
    const other = spawn('sleep', ['300']);
    try {
      const config = load({ ECS_AGENT_URI: ecs.uri, SRE_WORKSPACE_PER_INSTANCE: '1', SRE_RUNNER_INSTANCE: 'pool-1' });
      assert.equal(config.layout.perInstance, true);
      const files = internals.taskProtectionFiles(config);
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(path.join(files.dir, 'pool-2.hold'), `${other.pid} h-other\n`);
      await internals.protection.hold('h-mine');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, true);
      await internals.protection.release('h-mine');
      assert.equal(ecs.calls.filter((call) => call.body.ProtectionEnabled === false).length, 0, 'the other worker still holds a request');
      other.kill('SIGKILL');
      await new Promise((resolve) => other.on('close', resolve));
      await internals.protection.hold('h-again');
      await internals.protection.release('h-again');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, false, 'a holder whose process is gone does not count');
      assert.deepEqual(fs.readdirSync(files.dir), [], 'the markers are cleaned up');
    } finally {
      other.kill('SIGKILL');
      ecs.close();
    }
  });

  await check('the markers of another task on the same volume are not counted', async () => {
    const ecs = await agent();
    const other = spawn('sleep', ['300']);
    try {
      const config = load({ ECS_AGENT_URI: ecs.uri, SRE_WORKSPACE_PER_INSTANCE: '1', SRE_RUNNER_INSTANCE: 'pool-1' });
      const foreign = path.join(config.layout.locks, 'task-protection-ffffffffffff');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'elsewhere-1.hold'), `${other.pid} h-elsewhere\n`);
      await internals.protection.hold('h-1');
      await internals.protection.release('h-1');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, false);
    } finally {
      other.kill('SIGKILL');
      ecs.close();
    }
  });

  await check('protection is asked for again while the request lasts, and the asking stops with the release', async () => {
    const ecs = await agent();
    try {
      load({ ECS_AGENT_URI: ecs.uri });
      internals.setTaskProtectionRenewMs(120);
      await internals.protection.hold('h-long');
      await sleep(500);
      const ons = ecs.calls.filter((call) => call.body.ProtectionEnabled === true);
      assert.ok(ons.length >= 3, `${ons.length} calls turning it on`);
      assert.ok(ons.every((call) => call.body.ExpiresInMinutes === 60));
      await internals.protection.release('h-long');
      const settled = ecs.calls.length;
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, false);
      await sleep(400);
      assert.equal(ecs.calls.length, settled, 'a renewal came after the release');
    } finally {
      internals.setTaskProtectionRenewMs(20 * 60 * 1000);
      ecs.close();
    }
  });

  await check('a worker that died holding the counting lock does not block the others', async () => {
    const ecs = await agent();
    const dead = spawn('true');
    await new Promise((resolve) => dead.on('close', resolve));
    try {
      const config = load({ ECS_AGENT_URI: ecs.uri, SRE_WORKSPACE_PER_INSTANCE: '1', SRE_RUNNER_INSTANCE: 'pool-1' });
      const files = internals.taskProtectionFiles(config);
      fs.mkdirSync(config.layout.locks, { recursive: true });
      fs.writeFileSync(files.lock, `pool-9 ${dead.pid} ${new Date().toISOString()}\n`);
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(path.join(files.dir, 'pool-9.hold'), `${dead.pid} h-dead\n`);
      const started = Date.now();
      await internals.protection.hold('h-live');
      assert.ok(Date.now() - started < 3000, 'the hold waited for a dead worker');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, true);
      await internals.protection.release('h-live');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, false, 'the dead worker\'s marker does not keep it on');
    } finally {
      ecs.close();
    }
  });

  await check('a renewal in flight when the request is released leaves protection off and no marker behind', async () => {
    const ecs = await agent();
    const other = spawn('sleep', ['300']);
    try {
      const config = load({ ECS_AGENT_URI: ecs.uri, SRE_WORKSPACE_PER_INSTANCE: '1', SRE_RUNNER_INSTANCE: 'pool-1' });
      const files = internals.taskProtectionFiles(config);
      await internals.protection.hold('h-race');
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, true);
      // Another worker holds the counting lock, so the renewal waits for it.
      fs.writeFileSync(files.lock, `pool-2 ${other.pid} ${new Date().toISOString()}\n`);
      internals.setTaskProtectionRenewMs(40);
      await sleep(250);
      const release = internals.protection.release('h-race');
      await sleep(100);
      fs.rmSync(files.lock, { force: true });
      await release;
      await sleep(200);
      assert.equal(ecs.calls.at(-1).body.ProtectionEnabled, false, 'a late renewal turned it back on');
      assert.deepEqual(fs.readdirSync(files.dir).filter((name) => name.endsWith('.hold')), [], 'a marker was written back after the release');
    } finally {
      internals.setTaskProtectionRenewMs(20 * 60 * 1000);
      other.kill('SIGKILL');
      ecs.close();
    }
  });

  await check('at one runner the renewals stop with the release and the last call is the one that turns it off', async () => {
    const ecs = await agent(() => ({ status: 200, body: {} }));
    const calls = ecs.calls;
    try {
      load({ ECS_AGENT_URI: ecs.uri });
      internals.setTaskProtectionRenewMs(30);
      await internals.protection.hold('h-one');
      await sleep(200);
      await internals.protection.release('h-one');
      const settled = calls.length;
      await sleep(200);
      assert.equal(calls.length, settled);
      assert.equal(calls.at(-1).body.ProtectionEnabled, false);
    } finally {
      internals.setTaskProtectionRenewMs(20 * 60 * 1000);
      ecs.close();
    }
  });

  await check('the ECS agent address is not in the agent\'s environment', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'runner', 'runner.js'), 'utf8');
    assert.ok(/'SRE_AGENT_ACCOUNTS', 'ECS_AGENT_URI'/.test(source));
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
