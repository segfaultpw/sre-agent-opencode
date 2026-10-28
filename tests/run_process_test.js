'use strict';
// runProcess and the abort signal a heartbeat's stop answer fires: a signal
// already aborted starts nothing, and one aborted mid-run ends the child's
// whole process group the way the time bound does and says so. The runner's
// own checkpoints stop a taken job before it reaches the agent; this is the
// guard beneath them.
// Run with `node tests/run_process_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { internals } = require(path.resolve(__dirname, '..', 'runner', 'runner.js'));

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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-process-test-'));
  try {
    await check('a signal already aborted starts nothing and answers aborted', async () => {
      const marker = path.join(dir, 'ran');
      const controller = new AbortController();
      controller.abort('taken_over');
      const result = await internals.runProcess('bash', ['-c', `touch '${marker}'`], { signal: controller.signal });
      assert.equal(result.aborted, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, null);
      assert.equal(fs.existsSync(marker), false, 'the command ran');
    });

    await check('an abort mid-run ends the whole process group and answers aborted, not timed out', async () => {
      const pids = path.join(dir, 'pids');
      const controller = new AbortController();
      const started = Date.now();
      const running = internals.runProcess(
        'bash',
        ['-c', `sleep 60 & echo $! > '${pids}'; echo $$ >> '${pids}'; wait`],
        { signal: controller.signal, timeoutMs: 120_000 }
      );
      for (let waited = 0; waited < 100 && !(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').trim().split('\n').length === 2); waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      controller.abort('taken_over');
      const result = await running;
      assert.equal(result.aborted, true);
      assert.equal(result.timedOut, false);
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
      const group = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
      assert.equal(group.length, 2);
      for (const pid of group) assert.equal(alive(pid), false, `pid ${pid} is still running`);
    });

    await check('a run that ends before any abort answers neither aborted nor timed out', async () => {
      const controller = new AbortController();
      const result = await internals.runProcess('bash', ['-c', 'echo done'], { signal: controller.signal });
      controller.abort('late');
      assert.equal(result.code, 0);
      assert.equal(result.stdout.trim(), 'done');
      assert.equal(result.aborted, undefined);
      assert.equal(result.timedOut, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) process.exitCode = 1;
}

main();
