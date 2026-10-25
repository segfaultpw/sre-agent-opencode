'use strict';
// The base bundle the runner hands the agent holds a private repository's
// history and sits under the system temp directory, which every local account
// can list. Its directory is 0711 (the agent opens the file by name and cannot
// list it), so the file's name is what keeps other accounts out: it must be
// one nobody else can guess, and different every time.
// Run with `node tests/bundle_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { internals } = require('../runner/runner.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
const made = [];
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

function repository() {
  const work = path.join(root, 'work');
  const gitdir = path.join(root, 'gitdir');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args) => execFileSync('git', args, { env, stdio: 'pipe' });
  fs.mkdirSync(work);
  run(['init', '-q', '-b', 'main', `--separate-git-dir=${gitdir}`, work]);
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
  run(['-C', work, 'add', 'README.md']);
  run(['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base']);
  return { gitdir, branch: 'main' };
}

(async () => {
  const workspace = repository();
  const first = await internals.makeBaseBundle(workspace);
  const second = await internals.makeBaseBundle(workspace);
  made.push(first.dir, second.dir);

  await check('the bundle file has a random 128-bit name, not a fixed one', () => {
    assert.match(path.basename(first.file), /^base-[0-9a-f]{32}\.bundle$/);
  });
  await check('two bundles never share a name', () => {
    assert.notEqual(path.basename(first.file), path.basename(second.file));
  });
  await check('its directory can be walked through but not listed by other accounts', () => {
    assert.equal(fs.statSync(first.dir).mode & 0o777, 0o711);
  });
  await check('the bundle holds the base branch', () => {
    const heads = execFileSync('git', ['bundle', 'list-heads', first.file], { stdio: 'pipe' }).toString();
    assert.match(heads, /refs\/heads\/main$/m);
  });
})()
  .catch((error) => {
    failed += 1;
    console.log(`FAIL bundle test aborted: ${error.message}`);
  })
  .finally(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (failed) {
      console.log(`${failed} bundle test(s) failed`);
      process.exit(1);
    }
    console.log('all bundle tests passed');
  });
