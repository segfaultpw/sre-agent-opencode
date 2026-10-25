'use strict';
// Unit tests for runner/memory.js: the persistent workspace layout, the bounds
// the runner enforces on the agent's memory directory, and the change list the
// report carries; and for the test job's two small pieces that touch it, the
// removal of a marker a killed runner left (memory.clearTestMarkers) and the
// bucket probe (bucket.probe). Run with `node tests/memory_test.js`; every input is small
// and explicit, and the largest file written is a little over 1 MiB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const memory = require('../runner/memory.js');
const bucket = require('../runner/bucket.js');

let failed = 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
let counter = 0;

function fresh() {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(base, rel, content) {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function listing(base) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(base, '');
  return out;
}

const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push(
    fn().then(
      () => console.log(`ok   ${name}`),
      (error) => {
        failed += 1;
        console.log(`FAIL ${name}`);
        console.log(String(error && error.stack ? error.stack : error).replace(/^/gm, '     '));
      }
    )
  );
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(String(error && error.stack ? error.stack : error).replace(/^/gm, '     '));
  }
}

test('layout names the four directories under the workspace', () => {
  assert.deepEqual(memory.layout('/workspace'), {
    repos: '/workspace/repos',
    gitdirs: '/workspace/gitdirs',
    memory: '/workspace/memory',
    scratch: '/workspace/scratch',
  });
});

test('layout makes a relative workspace absolute', () => {
  const laid = memory.layout('some/where');
  assert.ok(path.isAbsolute(laid.repos));
  assert.ok(laid.repos.endsWith(path.join('some', 'where', 'repos')));
});

test('memoryDir for a repository object, a repository string and for no repository', () => {
  assert.equal(memory.memoryDir('/workspace', { owner: 'acme', name: 'api' }), '/workspace/memory/acme/api');
  assert.equal(memory.memoryDir('/workspace', 'acme/api'), '/workspace/memory/acme/api');
  assert.equal(memory.memoryDir('/workspace', null), '/workspace/memory/_estate');
  assert.equal(memory.memoryDir('/workspace'), '/workspace/memory/_estate');
});

test('memoryDir refuses a name with a slash, dots only, a bad character or too long', () => {
  for (const bad of [
    { owner: 'acme', name: '../x' },
    { owner: 'acme', name: 'a/b' },
    { owner: '..', name: 'api' },
    { owner: '.', name: 'api' },
    { owner: 'acme', name: '..' },
    { owner: 'ac me', name: 'api' },
    { owner: 'acme', name: '' },
    { owner: 'acme', name: 'x'.repeat(101) },
    { owner: '_estate', name: 'api' },
    'acme/api/extra',
    'acme',
    'acme/..',
  ]) {
    assert.throws(() => memory.memoryDir('/workspace', bad), /memory/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => memory.memoryDir('/workspace', { owner: 'a'.repeat(100), name: 'x.y_z-1' }));
});

test('migrate moves an old clone under repos and is a no-op the second time', () => {
  const ws = fresh();
  put(ws, 'acme/api/.git/HEAD', 'ref: refs/heads/main\n');
  put(ws, 'acme/api/README.md', 'hello');
  put(ws, 'acme/web/.git/HEAD', 'ref: refs/heads/main\n');
  put(ws, 'other/lib/.git/HEAD', 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(ws, 'scratch'));
  put(ws, 'scratch/answer.txt', 'last answer');
  put(ws, 'acme/not-a-clone/file.txt', 'x');

  const moved = memory.migrate(ws);
  assert.deepEqual([...moved].sort(), ['acme/api', 'acme/web', 'other/lib']);
  assert.ok(fs.existsSync(path.join(ws, 'repos/acme/api/.git/HEAD')));
  assert.equal(fs.readFileSync(path.join(ws, 'repos/acme/api/README.md'), 'utf8'), 'hello');
  assert.ok(fs.existsSync(path.join(ws, 'repos/other/lib/.git/HEAD')));
  assert.ok(!fs.existsSync(path.join(ws, 'acme/api')));
  assert.ok(!fs.existsSync(path.join(ws, 'other')), 'an owner directory left empty is removed');
  assert.ok(fs.existsSync(path.join(ws, 'acme/not-a-clone/file.txt')), 'a directory that is not a clone stays');
  assert.equal(fs.readFileSync(path.join(ws, 'scratch/answer.txt'), 'utf8'), 'last answer');

  const before = listing(ws);
  assert.deepEqual(memory.migrate(ws), []);
  assert.deepEqual(listing(ws), before);
});

test('migrate on an empty or missing workspace moves nothing', () => {
  assert.deepEqual(memory.migrate(fresh()), []);
  assert.deepEqual(memory.migrate(path.join(root, 'does-not-exist')), []);
});

test('migrate leaves an old clone alone when the new place is taken', () => {
  const ws = fresh();
  put(ws, 'acme/api/.git/HEAD', 'old');
  put(ws, 'repos/acme/api/.git/HEAD', 'new');
  assert.deepEqual(memory.migrate(ws), []);
  assert.equal(fs.readFileSync(path.join(ws, 'repos/acme/api/.git/HEAD'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(ws, 'acme/api/.git/HEAD'), 'utf8'), 'old');
});

test('migrate never treats the runner own directories as owners', () => {
  const ws = fresh();
  put(ws, 'agent-home/acme/.git/HEAD', 'x');
  put(ws, 'gitdirs/acme/api/HEAD', 'x');
  put(ws, 'gitdirs/acme/api/.git/HEAD', 'x');
  put(ws, 'memory/acme/api/.git/HEAD', 'x');
  put(ws, 'scratch/acme/.git/HEAD', 'x');
  assert.deepEqual(memory.migrate(ws), []);
  assert.ok(fs.existsSync(path.join(ws, 'memory/acme/api/.git/HEAD')));
  assert.ok(fs.existsSync(path.join(ws, 'gitdirs/acme/api/.git/HEAD')), 'a git directory is not moved under repos');
  assert.ok(fs.existsSync(path.join(ws, 'agent-home/acme/.git/HEAD')), 'the agent home is not an owner');
});

test('migrate never treats the runner own restore and mirror state as an owner', () => {
  const ws = fresh();
  put(ws, '.memory-restore-4242/acme/.git/HEAD', 'x');
  put(ws, '.memory-mirror-pending', '{}');
  assert.deepEqual(memory.migrate(ws), []);
  assert.ok(fs.existsSync(path.join(ws, '.memory-restore-4242/acme/.git/HEAD')), 'a staged restore is not moved under repos');
  assert.ok(!fs.existsSync(path.join(ws, 'repos/.memory-restore-4242')));
});

test('migrate skips a directory that cannot be an owner, such as the lost+found of a mounted disk', () => {
  const ws = fresh();
  put(ws, 'acme/api/.git/HEAD', 'x');
  const lost = path.join(ws, 'lost+found');
  fs.mkdirSync(lost);
  fs.chmodSync(lost, 0o000);
  try {
    assert.deepEqual(memory.migrate(ws), ['acme/api']);
    assert.ok(fs.existsSync(path.join(ws, 'repos/acme/api/.git/HEAD')));
    assert.ok(fs.existsSync(lost), 'it is left where it is');
  } finally {
    fs.chmodSync(lost, 0o700);
  }
});

test('migrate does not follow a symlinked owner directory', () => {
  const ws = fresh();
  const outside = fresh();
  put(outside, 'repo/.git/HEAD', 'x');
  fs.symlinkSync(outside, path.join(ws, 'acme'));
  assert.deepEqual(memory.migrate(ws), []);
  assert.ok(fs.existsSync(path.join(outside, 'repo/.git/HEAD')));
});

test('snapshot maps relative paths to bytes and sha256, regular files only', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'abc');
  put(dir, 'scripts/run.sh', '#!/bin/sh\n');
  fs.symlinkSync('/etc/hostname', path.join(dir, 'link'));
  const snap = memory.snapshot(dir);
  assert.deepEqual([...snap.keys()].sort(), ['NOTES.md', 'scripts/run.sh']);
  assert.equal(snap.get('NOTES.md').bytes, 3);
  assert.equal(snap.get('NOTES.md').sha256, crypto.createHash('sha256').update('abc').digest('hex'));
  assert.equal(snap.get('scripts/run.sh').bytes, 10);
});

test('snapshot of a missing directory is empty', () => {
  assert.equal(memory.snapshot(path.join(root, 'nope')).size, 0);
});

test('enforce cuts nothing under the bounds', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'notes');
  put(dir, 'scripts/a.sh', 'echo a\n');
  put(dir, 'scripts/b.py', 'print(1)\n');
  const previous = memory.snapshot(dir);
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.kept, ['NOTES.md', 'scripts/a.sh', 'scripts/b.py']);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(listing(dir), ['NOTES.md', 'scripts/a.sh', 'scripts/b.py']);
});

test('enforce on a missing or empty directory reports nothing', () => {
  const empty = { kept: [], restored: [], removed: [], notes: [] };
  assert.deepEqual(memory.enforce(path.join(root, 'nope'), new Map()), empty);
  assert.deepEqual(memory.enforce(fresh(), new Map()), empty);
});

test('an oversized notes file keeps the previous version', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'the earlier notes\n');
  const previous = memory.snapshot(dir);
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'x'.repeat(memory.MAX_NOTES_BYTES + 1));
  const result = memory.enforce(dir, previous);
  assert.equal(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), 'the earlier notes\n');
  assert.deepEqual(result.restored, ['NOTES.md']);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /NOTES\.md/);
  assert.match(result.notes[0], /previous version/);
});

test('a notes file at exactly the limit is kept', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'x'.repeat(memory.MAX_NOTES_BYTES));
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(result.kept, ['NOTES.md']);
  assert.equal(fs.statSync(path.join(dir, 'NOTES.md')).size, 65536);
});

test('an oversized notes file with no previous version is removed', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'x'.repeat(memory.MAX_NOTES_BYTES + 1));
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(result.removed, ['NOTES.md']);
  assert.ok(!fs.existsSync(path.join(dir, 'NOTES.md')));
  assert.equal(result.notes.length, 1);
});

test('a 51st script is removed and the earlier fifty stay', () => {
  const dir = fresh();
  for (let i = 0; i < 50; i += 1) put(dir, `scripts/s${String(i).padStart(2, '0')}.sh`, `echo ${i}\n`);
  const previous = memory.snapshot(dir);
  put(dir, 'scripts/aaa-new.sh', 'echo new\n');
  put(dir, 'scripts/zzz-new.sh', 'echo new\n');
  const result = memory.enforce(dir, previous);
  assert.equal(fs.readdirSync(path.join(dir, 'scripts')).length, 50);
  assert.deepEqual(result.removed, ['scripts/aaa-new.sh', 'scripts/zzz-new.sh']);
  assert.ok(fs.existsSync(path.join(dir, 'scripts/s00.sh')));
  assert.equal(result.notes.length, 2);
});

test('exactly fifty scripts are kept', () => {
  const dir = fresh();
  for (let i = 0; i < 50; i += 1) put(dir, `scripts/s${i}.sh`, 'x');
  const result = memory.enforce(dir, new Map());
  assert.equal(result.kept.length, 50);
  assert.deepEqual(result.removed, []);
});

test('a symlink and a FIFO are removed, and a symlink never lets a file out', () => {
  const dir = fresh();
  const outside = fresh();
  put(outside, 'secret.txt', 'secret');
  put(dir, 'NOTES.md', 'ok');
  put(dir, 'scripts/real.sh', 'echo\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'scripts/link.sh'));
  fs.symlinkSync(outside, path.join(dir, 'scripts/dirlink'));
  execFileSync('mkfifo', [path.join(dir, 'scripts/pipe.sh')]);
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(result.removed, ['scripts/dirlink', 'scripts/link.sh', 'scripts/pipe.sh']);
  assert.deepEqual(listing(dir), ['NOTES.md', 'scripts/real.sh']);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')), 'the link target is untouched');
});

test('a notes file replaced by a symlink is restored from the previous version', () => {
  const dir = fresh();
  const outside = fresh();
  put(outside, 'x.md', 'outside');
  put(dir, 'NOTES.md', 'mine');
  const previous = memory.snapshot(dir);
  fs.rmSync(path.join(dir, 'NOTES.md'));
  fs.symlinkSync(path.join(outside, 'x.md'), path.join(dir, 'NOTES.md'));
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.restored, ['NOTES.md']);
  assert.ok(!fs.lstatSync(path.join(dir, 'NOTES.md')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), 'mine');
});

test('a scripts directory replaced by a symlink is replaced by the previous scripts', () => {
  const dir = fresh();
  const outside = fresh();
  put(dir, 'scripts/a.sh', 'echo a\n');
  put(dir, 'scripts/b.sh', 'echo b\n');
  const previous = memory.snapshot(dir);
  fs.rmSync(path.join(dir, 'scripts'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'scripts'));
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.restored, ['scripts/a.sh', 'scripts/b.sh']);
  assert.ok(fs.lstatSync(path.join(dir, 'scripts')).isDirectory());
  assert.deepEqual(listing(dir), ['scripts/a.sh', 'scripts/b.sh']);
});

test('names outside the allowed set are removed, and nesting is not kept', () => {
  const dir = fresh();
  put(dir, 'scripts/has space.sh', 'x');
  put(dir, 'scripts/semi;colon.sh', 'x');
  put(dir, 'scripts/ünï.sh', 'x');
  put(dir, `scripts/${'n'.repeat(101)}`, 'x');
  put(dir, 'scripts/nested/inner.sh', 'x');
  put(dir, 'scripts/good-name_1.2.sh', 'x');
  put(dir, 'extra.txt', 'x');
  put(dir, 'other/dir/file', 'x');
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(listing(dir), ['scripts/good-name_1.2.sh']);
  assert.equal(result.removed.length, 7);
  assert.deepEqual(result.kept, ['scripts/good-name_1.2.sh']);
});

test('validName refuses a slash, dots only, an empty and an overlong name', () => {
  for (const bad of ['a/b', '..', '.', '', 'x'.repeat(101), 'a b', 'a\0b', 'a\\b']) {
    assert.equal(memory.validName(bad), false, JSON.stringify(bad));
  }
  for (const good of ['NOTES.md', 'a.sh', 'x'.repeat(100), '.hidden', '..a', 'A-b_c.1']) {
    assert.equal(memory.validName(good), true, good);
  }
  assert.equal(memory.validName(undefined), false);
});

test('the directory total is held to 1 MiB by reverting what the run changed', () => {
  const dir = fresh();
  put(dir, 'scripts/old.sh', 'y'.repeat(600000));
  const previous = memory.snapshot(dir);
  put(dir, 'scripts/big-new.sh', 'z'.repeat(500000));
  put(dir, 'scripts/small-new.sh', 'w'.repeat(1000));
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.removed, ['scripts/big-new.sh']);
  assert.deepEqual(listing(dir), ['scripts/old.sh', 'scripts/small-new.sh']);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /1048576/);
});

test('a script that grew past the total is restored to its previous content', () => {
  const dir = fresh();
  put(dir, 'scripts/a.sh', 'small\n');
  put(dir, 'scripts/b.sh', 'y'.repeat(100000));
  const previous = memory.snapshot(dir);
  fs.writeFileSync(path.join(dir, 'scripts/a.sh'), 'g'.repeat(memory.MAX_DIR_BYTES));
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.restored, ['scripts/a.sh']);
  assert.equal(fs.readFileSync(path.join(dir, 'scripts/a.sh'), 'utf8'), 'small\n');
});

test('with no previous state, the largest scripts go first until the total fits', () => {
  const dir = fresh();
  put(dir, 'scripts/a.sh', 'a'.repeat(600000));
  put(dir, 'scripts/b.sh', 'b'.repeat(500000));
  put(dir, 'scripts/c.sh', 'c'.repeat(1000));
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(result.removed, ['scripts/a.sh']);
  assert.deepEqual(listing(dir), ['scripts/b.sh', 'scripts/c.sh']);
});

test('a total exactly at 1 MiB is kept', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'n'.repeat(memory.MAX_NOTES_BYTES));
  put(dir, 'scripts/a.sh', 'a'.repeat(memory.MAX_DIR_BYTES - memory.MAX_NOTES_BYTES));
  const result = memory.enforce(dir, new Map());
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept.length, 2);
});

test('a deleted script and a rewritten script are the agent own business', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'one');
  put(dir, 'scripts/gone.sh', 'x');
  put(dir, 'scripts/edit.sh', 'v1');
  const previous = memory.snapshot(dir);
  fs.rmSync(path.join(dir, 'scripts/gone.sh'));
  fs.writeFileSync(path.join(dir, 'scripts/edit.sh'), 'v2');
  const result = memory.enforce(dir, previous);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, ['NOTES.md', 'scripts/edit.sh']);
});

test('a restored script keeps its mode', () => {
  const dir = fresh();
  put(dir, 'scripts/run.sh', 'echo\n');
  fs.chmodSync(path.join(dir, 'scripts/run.sh'), 0o755);
  const previous = memory.snapshot(dir);
  fs.rmSync(path.join(dir, 'scripts/run.sh'));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'scripts/run.sh'));
  memory.enforce(dir, previous);
  assert.equal(fs.statSync(path.join(dir, 'scripts/run.sh')).mode & 0o777, 0o755);
});

test('changes lists added, modified and removed, sorted by path under the prefix', () => {
  const before = new Map([
    ['NOTES.md', { bytes: 10, sha256: 'a' }],
    ['scripts/keep.sh', { bytes: 5, sha256: 'k' }],
    ['scripts/gone.sh', { bytes: 7, sha256: 'g' }],
  ]);
  const after = new Map([
    ['NOTES.md', { bytes: 12, sha256: 'b' }],
    ['scripts/keep.sh', { bytes: 5, sha256: 'k' }],
    ['scripts/new.sh', { bytes: 3, sha256: 'n' }],
  ]);
  assert.deepEqual(memory.changes(before, after, 'acme/api'), [
    { path: 'acme/api/NOTES.md', change: 'modified', bytes: 12 },
    { path: 'acme/api/scripts/gone.sh', change: 'removed', bytes: 7 },
    { path: 'acme/api/scripts/new.sh', change: 'added', bytes: 3 },
  ]);
});

test('changes sees a different sha with the same size as modified', () => {
  const before = new Map([['NOTES.md', { bytes: 4, sha256: 'a' }]]);
  const after = new Map([['NOTES.md', { bytes: 4, sha256: 'b' }]]);
  assert.deepEqual(memory.changes(before, after, '_estate'), [
    { path: '_estate/NOTES.md', change: 'modified', bytes: 4 },
  ]);
});

test('changes with nothing different is empty, and a prefix with a trailing slash is the same prefix', () => {
  const same = new Map([['NOTES.md', { bytes: 4, sha256: 'a' }]]);
  assert.deepEqual(memory.changes(same, new Map(same), 'acme/api'), []);
  assert.deepEqual(memory.changes(new Map(), same, 'acme/api/'), [
    { path: 'acme/api/NOTES.md', change: 'added', bytes: 4 },
  ]);
  assert.deepEqual(memory.changes(new Map(), same, ''), [{ path: 'NOTES.md', change: 'added', bytes: 4 }]);
});

test('changes caps at 50 entries, keeping the first by path', () => {
  const after = new Map();
  for (let i = 0; i < 60; i += 1) after.set(`scripts/s${String(i).padStart(2, '0')}.sh`, { bytes: i, sha256: String(i) });
  const listed = memory.changes(new Map(), after, 'acme/api');
  assert.equal(listed.length, 50);
  assert.equal(listed[0].path, 'acme/api/scripts/s00.sh');
  assert.equal(listed[49].path, 'acme/api/scripts/s49.sh');
  assert.ok(listed.every((entry) => entry.change === 'added'));
});

test('changes can be asked for every entry, as the mirror does, while the report keeps fifty', () => {
  const before = new Map();
  const after = new Map();
  for (let i = 0; i < 60; i += 1) {
    before.set(`scripts/a${String(i).padStart(2, '0')}`, { bytes: 1, sha256: `a${i}` });
    after.set(`scripts/b${String(i).padStart(2, '0')}`, { bytes: 1, sha256: `b${i}` });
  }
  before.set('NOTES.md', { bytes: 1, sha256: 'n1' });
  after.set('NOTES.md', { bytes: 1, sha256: 'n2' });
  assert.equal(memory.changes(before, after, 'acme/api').length, 50);
  const everything = memory.changes(before, after, 'acme/api', { limit: Infinity, maxPath: Infinity });
  assert.equal(everything.length, 121);
  assert.equal(everything.filter((entry) => entry.change === 'added').length, 60);
  assert.equal(everything.filter((entry) => entry.change === 'removed').length, 60);
  assert.ok(everything.some((entry) => entry.path === 'acme/api/scripts/b59' && entry.change === 'added'));
});

test('changes with no limit keeps a path longer than the report allows, because the mirror still has to copy it', () => {
  const long = `scripts/${'n'.repeat(100)}`;
  const after = new Map([[long, { bytes: 1, sha256: '1' }]]);
  assert.equal(memory.changes(new Map(), after, 'p'.repeat(250)).length, 0);
  const listed = memory.changes(new Map(), after, 'p'.repeat(250), { limit: Infinity, maxPath: Infinity });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path.length, 250 + 1 + long.length);
});

test('changes sorts by code unit, not by locale', () => {
  const after = new Map([
    ['scripts/b', { bytes: 1, sha256: '1' }],
    ['scripts/B', { bytes: 1, sha256: '2' }],
    ['NOTES.md', { bytes: 1, sha256: '3' }],
  ]);
  assert.deepEqual(
    memory.changes(new Map(), after, 'r').map((entry) => entry.path),
    ['r/NOTES.md', 'r/scripts/B', 'r/scripts/b'],
  );
});

test('changes drops a path longer than the 300 characters the contract allows', () => {
  const long = `scripts/${'n'.repeat(100)}`;
  const after = new Map([[long, { bytes: 1, sha256: '1' }]]);
  assert.equal(memory.changes(new Map(), after, 'p'.repeat(250)).length, 0);
  assert.equal(memory.changes(new Map(), after, 'p'.repeat(150)).length, 1);
});

test('snapshot, enforce and changes agree end to end on one run', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'first\n');
  put(dir, 'scripts/probe.sh', 'echo probe\n');
  const before = memory.snapshot(dir);
  put(dir, 'NOTES.md', 'first\nsecond\n');
  put(dir, 'scripts/new.sh', 'echo new\n');
  fs.rmSync(path.join(dir, 'scripts/probe.sh'));
  const result = memory.enforce(dir, before);
  assert.deepEqual(result.removed, []);
  const after = memory.snapshot(dir);
  assert.deepEqual(memory.changes(before, after, 'acme/api'), [
    { path: 'acme/api/NOTES.md', change: 'modified', bytes: 13 },
    { path: 'acme/api/scripts/new.sh', change: 'added', bytes: 9 },
    { path: 'acme/api/scripts/probe.sh', change: 'removed', bytes: 11 },
  ]);
});

test('enforce survives a script that disappears between the listing and the check', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'n');
  put(dir, 'scripts/gone.sh', 'x');
  put(dir, 'scripts/stays.sh', 'y');
  const real = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    if (String(target).endsWith('gone.sh')) {
      const error = new Error('ENOENT: no such file or directory');
      error.code = 'ENOENT';
      throw error;
    }
    return real(target, ...rest);
  };
  let result;
  try {
    result = memory.enforce(dir, new Map());
  } finally {
    fs.lstatSync = real;
  }
  assert.ok(result.kept.includes('scripts/stays.sh'));
  assert.ok(!result.kept.includes('scripts/gone.sh'));
});

test('snapshot stops reading at the directory bound and marks the file oversize', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'small');
  put(dir, 'scripts/a.sh', 'a'.repeat(700000));
  put(dir, 'scripts/b.sh', 'b'.repeat(700000));
  const snap = memory.snapshot(dir);
  assert.equal(snap.get('scripts/a.sh').oversize, undefined);
  assert.equal(snap.get('scripts/b.sh').oversize, true);
  assert.equal(snap.get('scripts/b.sh').sha256, null);
  assert.equal(snap.get('scripts/b.sh').content, undefined);
  assert.ok(memory.check(snap).some((problem) => /scripts\/b\.sh/.test(problem)));
});

test('a file that grows while it is read is cut at the bound, not hashed whole', () => {
  const dir = fresh();
  put(dir, 'scripts/grow.sh', 'g'.repeat(100));
  const real = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    const stat = real(target, ...rest);
    if (String(target).endsWith('grow.sh')) {
      fs.writeFileSync(target, 'g'.repeat(memory.MAX_DIR_BYTES + 5000));
    }
    return stat;
  };
  let snap;
  try {
    snap = memory.snapshot(dir);
  } finally {
    fs.lstatSync = real;
  }
  assert.equal(snap.get('scripts/grow.sh').oversize, true);
  assert.ok(memory.check(snap).length > 0);
});

test('check accepts what enforce leaves and names every bound a snapshot breaks', () => {
  const ok = fresh();
  put(ok, 'NOTES.md', 'notes');
  put(ok, 'scripts/a.sh', 'echo a\n');
  assert.deepEqual(memory.check(memory.snapshot(ok)), []);
  assert.deepEqual(memory.check(new Map()), []);

  const notes = new Map([['NOTES.md', { bytes: memory.MAX_NOTES_BYTES + 1, sha256: 'x', mode: 0o600, content: Buffer.alloc(0) }]]);
  assert.ok(memory.check(notes).some((problem) => /NOTES\.md/.test(problem)));

  const many = new Map();
  for (let i = 0; i < 51; i += 1) many.set(`scripts/s${i}.sh`, { bytes: 1, sha256: 'x', mode: 0o600, content: Buffer.from('x') });
  assert.ok(memory.check(many).some((problem) => /51 scripts/.test(problem)));

  const stray = new Map([['other/file', { bytes: 1, sha256: 'x', mode: 0o600, content: Buffer.from('x') }]]);
  assert.ok(memory.check(stray).some((problem) => /other\/file/.test(problem)));

  const total = new Map([
    ['scripts/a.sh', { bytes: 600000, sha256: 'x', mode: 0o600, content: Buffer.alloc(0) }],
    ['scripts/b.sh', { bytes: 600000, sha256: 'x', mode: 0o600, content: Buffer.alloc(0) }],
  ]);
  assert.ok(memory.check(total).some((problem) => /bytes/.test(problem)));
});

test('recover puts a lone .old directory back and removes the staging leftovers', () => {
  const ws = fresh();
  put(ws, 'memory/acme/api.sre-agent-old-111/NOTES.md', 'the memory a crash left aside');
  put(ws, 'memory/acme/web/NOTES.md', 'live');
  put(ws, 'memory/acme/web.sre-agent-old-222/NOTES.md', 'older');
  put(ws, 'memory/acme/web.sre-agent-new-333/NOTES.md', 'half written');
  put(ws, 'memory/_estate.sre-agent-new-444/NOTES.md', 'half written');
  put(ws, 'memory/_estate.sre-agent-old-555/NOTES.md', 'estate before the crash');
  const notes = memory.recover(ws);
  assert.equal(fs.readFileSync(path.join(ws, 'memory/acme/api/NOTES.md'), 'utf8'), 'the memory a crash left aside');
  assert.equal(fs.readFileSync(path.join(ws, 'memory/acme/web/NOTES.md'), 'utf8'), 'live');
  assert.equal(fs.readFileSync(path.join(ws, 'memory/_estate/NOTES.md'), 'utf8'), 'estate before the crash');
  assert.deepEqual(listing(path.join(ws, 'memory')), ['_estate/NOTES.md', 'acme/api/NOTES.md', 'acme/web/NOTES.md']);
  assert.equal(notes.length, 5);
  assert.deepEqual(memory.recover(ws), []);
});

test('recover on a workspace with no memory does nothing', () => {
  assert.deepEqual(memory.recover(fresh()), []);
  assert.deepEqual(memory.recover(path.join(root, 'does-not-exist')), []);
});

test('blobSha is the sha1 git hashes a file with', () => {
  assert.equal(memory.blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(memory.blobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('admit keeps exactly the files enforce would keep from a directory nothing came before', () => {
  const cases = {
    'a note over the bound': { 'NOTES.md': 70000, 'scripts/ok.sh': 10 },
    'a note at the bound': { 'NOTES.md': 65536, 'scripts/ok.sh': 10 },
    'a script over the directory bound': { 'scripts/huge.sh': 2000000, 'scripts/ok.sh': 10 },
    'sixty scripts': Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`scripts/s${String(index + 1).padStart(2, '0')}`, 5])),
    'the probe: a note, a 2 MB script and sixty scripts': {
      'NOTES.md': 70000,
      'scripts/huge.sh': 2000000,
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`scripts/s${String(index + 1).padStart(2, '0')}`, 5])),
    },
    'scripts that together pass the directory bound': { 'NOTES.md': 100, 'scripts/a': 600000, 'scripts/b': 600000, 'scripts/c': 100 },
    'two scripts of one size': { 'scripts/a': 600000, 'scripts/b': 600000 },
    'the note is the largest in a full directory': { 'NOTES.md': 65000, 'scripts/a': 500000, 'scripts/b': 500000 },
    'a name outside the allowed set': { 'scripts/ok.sh': 5, 'scripts/bad name': 5, 'scripts/semi;colon': 5 },
    'nothing': {},
  };
  for (const [label, sizes] of Object.entries(cases)) {
    const dir = fresh();
    for (const [rel, bytes] of Object.entries(sizes)) put(dir, rel, Buffer.alloc(bytes, 97));
    const candidates = Object.entries(sizes).map(([rel, bytes]) => ({ rel, bytes }));
    const admitted = memory.admit(candidates);
    const { kept } = memory.enforce(dir, new Map());
    assert.deepEqual(admitted, kept, label);
  }
});

test('admit judges names and sizes only, and never lists more than the bounds allow', () => {
  assert.deepEqual(memory.admit([]), []);
  const sixty = Array.from({ length: 60 }, (_, index) => ({ rel: `scripts/s${String(index + 1).padStart(2, '0')}`, bytes: 5 }));
  const admitted = memory.admit([{ rel: 'NOTES.md', bytes: 65537 }, ...sixty]);
  assert.equal(admitted.length, memory.MAX_SCRIPTS);
  assert.ok(!admitted.includes('NOTES.md'));
  assert.deepEqual(memory.admit([{ rel: 'other.txt', bytes: 1 }, { rel: 'scripts/sub/x', bytes: 1 }, { rel: 'scripts/..', bytes: 1 }]), []);
});

test('clearTestMarkers removes the marker of every memory directory and nothing else', () => {
  const workspace = fresh();
  const mem = path.join(workspace, 'memory');
  put(mem, '_estate/NOTES.md', 'estate');
  put(mem, '_estate/.runner-test', 'x');
  put(mem, 'acme/app/NOTES.md', 'app');
  put(mem, 'acme/app/.runner-test', 'x');
  put(mem, 'acme/app/scripts/.runner-test-not', 'a script that merely starts the same way');
  put(mem, 'acme/api/scripts/keep.sh', '#!/bin/sh');
  assert.deepEqual(memory.clearTestMarkers(workspace).sort(), ['_estate/.runner-test', 'acme/app/.runner-test']);
  assert.deepEqual(listing(mem), ['_estate/NOTES.md', 'acme/api/scripts/keep.sh', 'acme/app/NOTES.md', 'acme/app/scripts/.runner-test-not']);
  assert.deepEqual(memory.clearTestMarkers(workspace), [], 'a second call finds nothing');
  assert.deepEqual(memory.clearTestMarkers(path.join(workspace, 'absent')), [], 'a workspace with no memory directory is not an error');
});

test('the marker is not a memory file the bounds would keep', () => {
  const dir = fresh();
  put(dir, 'NOTES.md', 'n');
  put(dir, memory.TEST_MARKER, 'x');
  assert.deepEqual(memory.admit([{ rel: memory.TEST_MARKER, bytes: 1 }, { rel: `scripts/${memory.TEST_MARKER}`, bytes: 1 }]), [`scripts/${memory.TEST_MARKER}`], 'by shape alone a script of that name is a script: the marker is placed outside scripts/ for that reason');
  const { kept, removed } = memory.enforce(dir, new Map());
  assert.deepEqual(kept, ['NOTES.md']);
  assert.deepEqual(removed, [memory.TEST_MARKER]);
});

function fakeBucket(overrides = {}) {
  const calls = [];
  const config = {
    bucket: 'acme-sre-memory',
    prefix: 'fleet/',
    workspace: fresh(),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    ...overrides,
  };
  return { config, calls };
}

testAsync('probe puts the marker outside scripts/ and removes it, two calls, each with the probe timeout', async () => {
  const { config, calls } = fakeBucket({ probeTimeoutMs: 1234 });
  const answer = await bucket.probe(config, 'acme/app', '/somewhere/.runner-test');
  assert.deepEqual(answer, { ok: true, calls: 2 });
  assert.deepEqual(calls.map((call) => call.args), [
    ['s3', 'cp', '/somewhere/.runner-test', 's3://acme-sre-memory/fleet/acme/app/.runner-test', '--only-show-errors'],
    ['s3', 'rm', 's3://acme-sre-memory/fleet/acme/app/.runner-test', '--only-show-errors'],
  ]);
  assert.ok(calls.every((call) => call.command === 'aws' && call.options.timeoutMs === 1234));
});

testAsync('probe ignores the mirror deadline and a journal of any size', async () => {
  const { config, calls } = fakeBucket({ deadlineMs: 1 });
  fs.mkdirSync(config.workspace, { recursive: true });
  const paths = {};
  for (let index = 0; index < 500; index += 1) paths[`acme/r${index}/NOTES.md`] = 'added';
  paths['acme/gone/NOTES.md'] = 'added';
  fs.writeFileSync(path.join(config.workspace, '.memory-mirror-pending'), JSON.stringify({ version: 1, paths }));
  const answer = await bucket.probe(config, '_estate', '/v/.runner-test');
  assert.equal(answer.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.timeoutMs, 60_000);
});

testAsync('probe says which call failed, and that a marker it could not remove is left for the next test job', async () => {
  const failing = (needle) => async (command, args) => (args.includes(needle) ? { code: 1, stdout: '', stderr: 'An error occurred (AccessDenied)', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false });
  const put = await bucket.probe(fakeBucket({ run: failing('cp') }).config, '_estate', '/v/.runner-test');
  assert.equal(put.ok, false);
  assert.equal(put.calls, 1);
  assert.match(put.error, /did not take the marker \(aws s3 cp: An error occurred \(AccessDenied\)\)/);
  const removal = await bucket.probe(fakeBucket({ run: failing('rm') }).config, '_estate', '/v/.runner-test');
  assert.equal(removal.ok, false);
  assert.equal(removal.calls, 2);
  assert.match(removal.error, /could not be removed \(aws s3 rm: An error occurred \(AccessDenied\)\); the next test job removes it/);
  const thrown = await bucket.probe(fakeBucket({ run: async () => { throw new Error('spawn aws ENOENT'); } }).config, '_estate', '/v/.runner-test');
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /spawn aws ENOENT/);
});

testAsync('probe refuses a place that is not a memory directory, and puts nothing while a restore is pending', async () => {
  const { config, calls } = fakeBucket();
  for (const label of ['', '..', 'a/../b', 'acme/app bad', undefined]) {
    const answer = await bucket.probe(config, label, '/v/.runner-test');
    assert.equal(answer.ok, false, String(label));
  }
  fs.mkdirSync(config.workspace, { recursive: true });
  fs.writeFileSync(path.join(config.workspace, '.memory-restore-pending'), '{}');
  const pending = await bucket.probe(config, 'acme/app', '/v/.runner-test');
  assert.equal(pending.ok, false);
  assert.match(pending.error, /restore/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await bucket.probe({ ...config, bucket: '' }, 'acme/app', '/v/.runner-test'), { ok: true, calls: 0, skipped: 'no bucket is configured' });
});

Promise.all(asyncTests).then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.log(`${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('all memory tests passed');
});
