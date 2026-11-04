'use strict';
// The concurrency supervisor (runner/supervisor.js): SRE_CONCURRENCY workers of
// the runner, each with an instance id of its own, restarted when one crashes,
// stopped together by SIGTERM, refused with exit status 2 for a bad value; and
// the entrypoint, which starts the runner itself (no supervisor in the process
// tree) for 1 or unset. The supervisor is copied beside a stub runner.js so a
// worker is a process this test controls; the real runner under it is in
// tests/runner_test.sh.
// Run with `node tests/supervisor_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
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

async function until(condition, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return false;
}

// The supervisor next to the real memory.js and a stub runner.js that records
// its start and obeys STUB_MODE: wait (default), exit0, crash, crash_once.
function stage() {
  counter += 1;
  const dir = path.join(work, `pkg-${counter}`);
  fs.mkdirSync(path.join(dir, 'runner'), { recursive: true });
  for (const file of ['supervisor.js', 'memory.js']) fs.copyFileSync(path.join(packageRoot, 'runner', file), path.join(dir, 'runner', file));
  fs.writeFileSync(
    path.join(dir, 'runner', 'runner.js'),
    `'use strict';
const fs = require('node:fs');
const log = process.env.STUB_LOG;
const instance = process.env.SRE_RUNNER_INSTANCE;
fs.appendFileSync(log, JSON.stringify({ event: 'start', instance, pid: process.pid, perInstance: process.env.SRE_WORKSPACE_PER_INSTANCE, concurrency: process.env.SRE_CONCURRENCY === undefined ? null : process.env.SRE_CONCURRENCY }) + '\\n');
console.log('hello from ' + instance);
const mode = process.env.STUB_MODE || 'wait';
if (mode === 'exit0') process.exit(0);
if (mode === 'crash') process.exit(1);
if (mode === 'crash_once' && instance.endsWith('-2')) {
  const flag = process.env.STUB_LOG + '.crashed';
  if (!fs.existsSync(flag)) {
    fs.writeFileSync(flag, '');
    process.exit(1);
  }
}
process.on('SIGTERM', () => {
  fs.appendFileSync(log, JSON.stringify({ event: 'term', instance }) + '\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`
  );
  return dir;
}

function launch(env, dir = stage()) {
  const workspace = path.join(work, `ws-${counter}`);
  const log = path.join(work, `log-${counter}.jsonl`);
  fs.writeFileSync(log, '');
  const child = spawn(process.execPath, [path.join(dir, 'runner', 'supervisor.js')], {
    env: { PATH: process.env.PATH, SRE_WORKSPACE: workspace, SRE_RUNNER_INSTANCE: 'pool', STUB_LOG: log, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '', err: '', code: undefined, signal: undefined, workspace, log };
  child.stdout.on('data', (chunk) => (state.out += chunk));
  child.stderr.on('data', (chunk) => (state.err += chunk));
  state.done = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      state.code = code;
      state.signal = signal;
      resolve();
    })
  );
  state.child = child;
  state.events = () =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return state;
}

const supervisor = require(path.join(packageRoot, 'runner', 'supervisor.js'));

async function main() {
  await check('parseConcurrency accepts 1 to 8 as plain digits and nothing else', () => {
    assert.equal(supervisor.parseConcurrency(undefined), 1);
    assert.equal(supervisor.parseConcurrency(''), 1);
    for (let value = 1; value <= 8; value += 1) assert.equal(supervisor.parseConcurrency(String(value)), value);
    for (const bad of ['0', '9', '10', '01', '2.0', ' 3', '3 ', 'two', '-1', '1e1', '+2']) assert.equal(supervisor.parseConcurrency(bad), null, bad);
  });

  await check('worker ids are the base with -1 to -K, cut so the whole id stays within 100 characters', () => {
    assert.deepEqual(supervisor.workerInstances('pool', 3), ['pool-1', 'pool-2', 'pool-3']);
    const long = supervisor.workerInstances('x'.repeat(100), 8);
    assert.equal(new Set(long).size, 8);
    for (const id of long) {
      assert.ok(id.length <= 100);
      assert.match(id, /^x+-[1-8]$/);
    }
  });

  await check('an invalid SRE_CONCURRENCY exits 2 with a sentence naming it, and starts nothing', async () => {
    for (const bad of ['0', '9', 'many', '01', '2.5']) {
      const dir = stage();
      const run = launch({ SRE_CONCURRENCY: bad }, dir);
      await run.done;
      assert.equal(run.code, 2, `${bad}: ${run.err}`);
      assert.match(run.err, /SRE_CONCURRENCY must be a whole number from 1 to 8/);
      assert.equal(run.events().length, 0);
    }
  });

  await check('K=3 starts three workers with distinct instance ids, the per-instance split and no SRE_CONCURRENCY of their own', async () => {
    const run = launch({ SRE_CONCURRENCY: '3' });
    try {
      assert.ok(await until(() => run.events().length === 3), run.err);
      const starts = run.events();
      assert.deepEqual(starts.map((event) => event.instance).sort(), ['pool-1', 'pool-2', 'pool-3']);
      assert.equal(new Set(starts.map((event) => event.pid)).size, 3);
      for (const event of starts) {
        assert.equal(event.perInstance, '1');
        assert.equal(event.concurrency, null);
        assert.ok(fs.statSync(path.join(run.workspace, 'instances', event.instance)).isDirectory());
      }
      assert.ok(await until(() => /\[pool-3\] hello from pool-3/.test(run.out)), run.out);
      assert.match(run.out, /\[pool-1\] hello from pool-1/);
    } finally {
      run.child.kill('SIGKILL');
    }
  });

  await check('SIGTERM reaches every worker and the supervisor exits 0 once they have stopped', async () => {
    const run = launch({ SRE_CONCURRENCY: '3' });
    assert.ok(await until(() => run.events().length === 3), run.err);
    run.child.kill('SIGTERM');
    await run.done;
    assert.equal(run.code, 0, run.err);
    const terms = run.events().filter((event) => event.event === 'term').map((event) => event.instance).sort();
    assert.deepEqual(terms, ['pool-1', 'pool-2', 'pool-3']);
  });

  await check('a worker that crashes is restarted after a pause, and the others are not touched', async () => {
    const run = launch({ SRE_CONCURRENCY: '3', STUB_MODE: 'crash_once' });
    try {
      assert.ok(await until(() => run.events().filter((event) => event.event === 'start').length === 4, 15_000), `starts: ${JSON.stringify(run.events())} err: ${run.err}`);
      const starts = run.events().filter((event) => event.event === 'start');
      assert.equal(starts.filter((event) => event.instance === 'pool-2').length, 2);
      assert.equal(starts.filter((event) => event.instance === 'pool-1').length, 1);
      assert.match(run.err, /worker pool-2 exited 1; restarting it in 5 s/);
    } finally {
      run.child.kill('SIGTERM');
      await run.done;
    }
  });

  await check('workers that all finish cleanly end the supervisor with 0 and are not restarted', async () => {
    const run = launch({ SRE_CONCURRENCY: '2', STUB_MODE: 'exit0' });
    await run.done;
    assert.equal(run.code, 0, run.err);
    assert.equal(run.events().length, 2);
  });

  await check('workers that keep crashing make the supervisor give up with a sentence and exit 1', async () => {
    const run = launch({ SRE_CONCURRENCY: '8', STUB_MODE: 'crash' });
    await Promise.race([run.done, sleep(30_000)]);
    assert.equal(run.code, 1, `${run.err}`);
    assert.match(run.err, /10 restarts have happened in the last minute, so the supervisor gives up/);
  });

  await check('a workspace the account cannot write refuses the start naming the directory', async () => {
    const dir = stage();
    const blocked = path.join(work, 'blocked-ws');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'instances'), 'a file where the directory belongs');
    const run = launch({ SRE_CONCURRENCY: '2', SRE_WORKSPACE: blocked }, dir);
    await run.done;
    assert.equal(run.code, 1);
    assert.match(run.err, /the instance directory .*instances\/pool-1 does not exist or is not writable/);
    assert.equal(run.events().length, 0);
  });

  // The entrypoint, with the tools it checks for as stubs, and the real runner
  // and supervisor behind it polling a port nothing listens on. What is looked
  // at is the process tree it leaves.
  function children(pid) {
    const found = [];
    for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
      const list = fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim();
      if (list) found.push(...list.split(/\s+/).map(Number));
    }
    return found;
  }
  const cmdline = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);

  function entrypointTree(env) {
    const bin = path.join(work, `bin-${(counter += 1)}`);
    fs.mkdirSync(bin);
    for (const tool of ['git', 'gh', 'opencode']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const workspace = path.join(work, `entry-ws-${counter}`);
    fs.mkdirSync(workspace);
    const child = spawn(path.join(packageRoot, 'runner', 'entrypoint.sh'), [], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: work,
        SRE_SERVER_URL: 'http://127.0.0.1:9',
        SRE_API_KEY: 'sre-agent-poll-entrypoint-test-0000000000000000000000',
        SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro',
        SRE_WORKSPACE: workspace,
        ...env,
      },
      stdio: 'ignore',
    });
    return child;
  }

  for (const value of [undefined, '1']) {
    await check(`the entrypoint with SRE_CONCURRENCY ${value === undefined ? 'unset' : value} is the runner itself: no supervisor, no child`, async () => {
      const child = entrypointTree(value === undefined ? {} : { SRE_CONCURRENCY: value });
      try {
        assert.ok(await until(() => cmdline(child.pid).some((arg) => arg.endsWith('runner/runner.js'))), 'the entrypoint did not become the runner');
        assert.equal(cmdline(child.pid).some((arg) => arg.endsWith('supervisor.js')), false);
        await sleep(500);
        assert.deepEqual(
          children(child.pid).map((pid) => cmdline(pid).join(' ')).filter((line) => /node/.test(line)),
          [],
          'the runner has a node child'
        );
      } finally {
        child.kill('SIGKILL');
      }
    });
  }

  await check('the entrypoint with SRE_CONCURRENCY 3 is the supervisor with three runners under it', async () => {
    const child = entrypointTree({ SRE_CONCURRENCY: '3' });
    try {
      assert.ok(await until(() => cmdline(child.pid).some((arg) => arg.endsWith('runner/supervisor.js'))), 'the entrypoint did not become the supervisor');
      assert.ok(await until(() => children(child.pid).length === 3), `children: ${children(child.pid)}`);
      for (const pid of children(child.pid)) assert.ok(cmdline(pid).some((arg) => arg.endsWith('runner/runner.js')));
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('close', resolve));
    }
  });

  await check('the entrypoint with an invalid SRE_CONCURRENCY exits 2', () => {
    const bin = path.join(work, 'bin-invalid');
    fs.mkdirSync(bin);
    for (const tool of ['git', 'gh', 'opencode']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const workspace = path.join(work, 'invalid-ws');
    fs.mkdirSync(workspace);
    const result = spawnSync(path.join(packageRoot, 'runner', 'entrypoint.sh'), [], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: work,
        SRE_SERVER_URL: 'http://127.0.0.1:9',
        SRE_API_KEY: 'sre-agent-poll-entrypoint-test-0000000000000000000000',
        SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro',
        SRE_WORKSPACE: workspace,
        SRE_CONCURRENCY: '9',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /SRE_CONCURRENCY must be a whole number from 1 to 8/);
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
