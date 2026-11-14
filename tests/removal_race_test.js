'use strict';
// The runner removes trees an agent has had, and a tree is never removed by
// following a path that something else can swap for a link while it is being
// walked: Node 22's fs.rmSync(recursive) does follow such a component (it
// resolves each child by its whole path, without O_NOFOLLOW), and the image ships
// Node 22. This starts a process that swaps directories of the tree for links to
// a directory outside it, as fast as it can, while the runner's own removal
// (removeTree) runs, under every Node this machine has (the one running this
// test, and Node 22 when it is installed: NODE22 names it, else nvm's), and
// asserts that nothing outside the tree was touched. Where fs.rmSync is shown to
// lose files in the same race the test says so, but never asserts it: whether
// the swap wins is the scheduler's.
// Run with `node tests/removal_race_test.js`. It needs python3 for the swapper
// (renameat2 with RENAME_EXCHANGE has no Node binding); without it the test says
// SKIP and passes, and in CI (CI=true) that is a failure.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runnerPath = path.resolve(__dirname, '..', 'runner', 'runner.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-race-'));
process.on('exit', () => spawnSync('rm', ['-rf', work]));

const ROUNDS = 3;
const FILES_IN_VICTIM = 200;

const SWAPPER = `
import os, sys, time, ctypes
libc = ctypes.CDLL(None, use_errno=True)
AT_FDCWD = -100
RENAME_EXCHANGE = 2
base, victim, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
stop = time.time() + 30
pairs = []
for i in range(count):
    link = os.path.join(base, "s%d" % i)
    try:
        os.symlink(victim, link)
    except OSError:
        pass
    pairs.append((os.path.join(base, "d%d" % i).encode(), link.encode()))
while time.time() < stop:
    for a, b in pairs:
        libc.renameat2(AT_FDCWD, a, AT_FDCWD, b, RENAME_EXCHANGE)
    if not os.path.isdir(base):
        break
`;

function nodes() {
  const found = new Map();
  const add = (binary) => {
    if (!binary || !fs.existsSync(binary)) return;
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
    if (version && !found.has(version)) found.set(version, binary);
  };
  add(process.execPath);
  add(process.env.NODE22);
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvm)) {
    for (const name of fs.readdirSync(nvm).filter((entry) => entry.startsWith('v22.')).sort().reverse().slice(0, 1)) add(path.join(nvm, name, 'bin', 'node'));
  }
  return found;
}

function build(round) {
  const root = path.join(work, `round-${round}`);
  const victim = path.join(work, `victim-${round}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(victim, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 't', 'x'), { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  for (let n = 1; n <= FILES_IN_VICTIM; n += 1) fs.writeFileSync(path.join(victim, `v${n}`), 'keep\n');
  for (let i = 0; i < 50; i += 1) {
    fs.mkdirSync(path.join(root, 't', 'x', `d${i}`));
    for (let j = 1; j <= 50; j += 1) fs.writeFileSync(path.join(root, 't', 'x', `d${i}`, `w${j}`), '');
  }
  return { tree: path.join(root, 't'), base: path.join(root, 't', 'x'), victim };
}

const REMOVER = `
const runner = require(${JSON.stringify(runnerPath)});
// No account split here: the swapper is this account's own, so a close pass would
// only fight it, and what is asked is the removal's own safety.
runner.internals.setIdentity({ mode: 'none', runner: null, agent: null });
const how = process.argv[1];
const target = process.argv[2];
const run = how === 'rmSync'
  ? () => { try { require('node:fs').rmSync(target, { recursive: true, force: true }); } catch (error) { console.error('rmSync threw ' + error.code); } return Promise.resolve(); }
  : () => runner.internals.removeTree(target);
run().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
`;

function race(binary, how, round) {
  const made = build(round);
  const swapper = spawn('python3', ['-c', SWAPPER, made.base, made.victim, '50'], { stdio: 'ignore' });
  const started = Date.now();
  while (Date.now() - started < 300) { /* let the swapper get going */ }
  // A removal that meets an entry swapped under it may stop with an error, which
  // is safe; what it must never do is reach what a link names.
  for (let attempt = 0; attempt < 3 && fs.existsSync(made.tree); attempt += 1) {
    spawnSync(binary, ['-e', REMOVER, how, made.tree], { encoding: 'utf8', timeout: 120_000 });
  }
  swapper.kill();
  const left = fs.readdirSync(made.victim).length;
  // Once nothing swaps any more, the same removal finishes the job.
  const after = spawnSync(binary, ['-e', REMOVER, how, made.tree], { encoding: 'utf8', timeout: 120_000 });
  return { left, gone: !fs.existsSync(made.tree), done: after };
}

function main() {
  if (spawnSync('python3', ['--version']).status !== 0) {
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
      console.log('FAIL python3 is not installed, and this is CI, where the swap has to be raced rather than skipped');
      process.exit(1);
    }
    console.log('SKIP python3 is not installed, so the swapper cannot run');
    return;
  }
  let failed = 0;
  for (const [version, binary] of nodes()) {
    let baseline = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const lost = FILES_IN_VICTIM - race(binary, 'rmSync', 100 + round).left;
      if (lost > 0) baseline += 1;
    }
    let worst = FILES_IN_VICTIM;
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const result = race(binary, 'removeTree', round);
        assert.equal(result.done.status, 0, `removeTree failed under ${version}: ${result.done.stderr}`);
        assert.equal(result.gone, true, 'the tree is gone');
        worst = Math.min(worst, result.left);
      }
      assert.equal(worst, FILES_IN_VICTIM, `files of the directory the links name were removed under ${version}`);
      console.log(`ok   removeTree under node ${version} (${ROUNDS} rounds against a process swapping directories for links): the directory the links named lost nothing (fs.rmSync lost files in ${baseline} of ${ROUNDS} rounds of the same race)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${error.message} (fs.rmSync lost files in ${baseline} of ${ROUNDS} rounds)`);
    }
  }
  if (failed > 0) process.exit(1);
}

main();
