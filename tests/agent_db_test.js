'use strict';
// opencode's SQLite database is opened in WAL mode, which a network file system
// (EFS, NFS) cannot serve: a run on one fails with "locking protocol". The
// runner points the database, and nothing else of opencode's, at a directory on
// the machine's own disk for the length of the run. This drives the three
// functions behind that (prepareAgentDb, removeAgentDb, sweepAgentDbs); the
// environment the agent really gets is checked by tests/runner_test.sh.
// Run with `node tests/agent_db_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { internals } = require(path.resolve(__dirname, '..', 'runner', 'runner.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-test-'));
const uid = process.getuid();
const gid = process.getgid();
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

(async () => {
  internals.setIdentity({ mode: 'none', runner: { uid, gid, home: root }, agent: null });

  await check('the database gets a directory of its own under the named local directory, private to the account', () => {
    const base = fs.mkdtempSync(path.join(root, 'base-'));
    const db = internals.prepareAgentDb({ SRE_AGENT_DB_DIR: base });
    assert.ok(db);
    assert.equal(path.dirname(db.dir), base);
    assert.equal(db.file, path.join(db.dir, 'opencode.db'));
    assert.equal(fs.statSync(db.dir).mode & 0o777, 0o700);
    internals.removeAgentDb(db);
    assert.equal(fs.existsSync(db.dir), false);
  });

  await check('two runs never share a directory', () => {
    const base = fs.mkdtempSync(path.join(root, 'base-'));
    const first = internals.prepareAgentDb({ SRE_AGENT_DB_DIR: base });
    const second = internals.prepareAgentDb({ SRE_AGENT_DB_DIR: base });
    assert.notEqual(first.dir, second.dir);
  });

  await check('with nothing named the temporary directory is used, and a relative name is ignored', () => {
    const named = internals.prepareAgentDb({});
    const relative = internals.prepareAgentDb({ SRE_AGENT_DB_DIR: 'relative/dir' });
    for (const db of [named, relative]) {
      assert.equal(path.dirname(db.dir), os.tmpdir());
      internals.removeAgentDb(db);
    }
  });

  await check('a directory that cannot be made gives null, not a failed run', () => {
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    assert.equal(internals.prepareAgentDb({ SRE_AGENT_DB_DIR: path.join(file, 'below') }), null);
    assert.equal(internals.removeAgentDb(null), undefined);
  });

  await check('a day-old directory of a killed run is swept, a fresh one and an unrelated one are not', () => {
    const base = fs.mkdtempSync(path.join(root, 'base-'));
    const old = path.join(base, 'sre-agent-db-old');
    const fresh = path.join(base, 'sre-agent-db-fresh');
    const other = path.join(base, 'something-else');
    for (const dir of [old, fresh, other]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(old, 'opencode.db-wal'), 'stale');
    const longAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(other, longAgo, longAgo);

    internals.sweepAgentDbs(base, Date.now());

    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(other), true);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.log(`${failed} check${failed === 1 ? '' : 's'} failed`);
    process.exit(1);
  }
})();
