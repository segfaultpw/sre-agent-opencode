'use strict';
// The agent's home is on the volume and is the agent's to write, so everything
// the runner does in it, it does to bytes the agent chose. This drives
// settleAgentHome and its neighbours against a home planted the way a hostile
// run would leave it: opencode's own configuration and plugins, links where a
// directory belongs, and a FIFO or a link to /dev/zero where the runner reads a
// file as root. The accounts are faked with the test's own uid on both sides, so
// the file handling is proved without privilege; tests/uid_split_test.sh proves
// the ownership half with real uids.
//
// A read that blocks or never ends is the failure these cases exist for, so the
// ones that could hang run in a child process with a bound and a small heap; a
// hang is a FAIL here and never a hung test run.
// Run with `node tests/agent_home_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const runnerPath = path.resolve(__dirname, '..', 'runner', 'runner.js');
const { internals } = require(runnerPath);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-test-'));
const uid = process.getuid();
const gid = process.getgid();
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

function fresh() {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, 'agent-home');
  const runnerHome = path.join(dir, 'runner-home');
  fs.mkdirSync(runnerHome);
  return { dir, base, runnerHome };
}

function useIdentity({ base, runnerHome }) {
  internals.setIdentity({
    mode: 'root',
    runner: { uid, gid, home: runnerHome },
    agent: { uid, gid, home: base },
  });
}

function put(file, content = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// Runs settleAgentHome in a process of its own, so that a read that never
// returns costs the bound and not the test run.
function settleInChild(setup, home) {
  const code = `
    const { internals } = require(${JSON.stringify(runnerPath)});
    const [base, runnerHome, home, uid, gid] = JSON.parse(process.argv[1]);
    internals.setIdentity({ mode: 'root', runner: { uid, gid, home: runnerHome }, agent: { uid, gid, home: base } });
    internals.settleAgentHome(home);
  `;
  try {
    execFileSync(
      process.execPath,
      ['--max-old-space-size=256', '-e', code, JSON.stringify([setup.base, setup.runnerHome, home, uid, gid])],
      { timeout: 20_000, stdio: 'pipe' }
    );
    return { ok: true };
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') return { ok: false, why: 'hung: no return within 20 seconds' };
    return { ok: false, why: `exited ${error.status} ${error.signal || ''} ${String(error.stderr || '').split('\n').slice(0, 3).join(' ')}` };
  }
}

(async () => {
  await check('the homes are per repository: the owner and the name under the agent home, and one for the estate', () => {
    const s = fresh();
    useIdentity(s);
    assert.equal(internals.agentHomeFor({ owner: 'acme', name: 'app' }), path.join(s.base, 'acme', 'app'));
    assert.equal(internals.agentHomeFor({ owner: 'acme', name: 'other' }), path.join(s.base, 'acme', 'other'));
    assert.equal(internals.agentHomeFor(null), path.join(s.base, '_estate'));
  });

  await check('settling creates the directories above a home 0711 and the home 0700', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    internals.settleAgentHome(home);
    assert.equal(fs.statSync(s.base).mode & 0o777, 0o711);
    assert.equal(fs.statSync(path.join(s.base, 'acme')).mode & 0o777, 0o711);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  });

  await check('everything opencode loads on its own is removed from the home before a run', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    put(path.join(home, '.config', 'opencode', 'plugin', 'x.js'));
    put(path.join(home, '.config', 'opencode', 'plugins', 'x.js'));
    put(path.join(home, '.config', 'opencode', 'agent', 'sre-fix.md'));
    put(path.join(home, '.config', 'opencode', 'opencode.json'), '{}');
    put(path.join(home, '.config', 'opencode', 'AGENTS.md'));
    put(path.join(home, '.opencode', 'plugin', 'x.js'));
    put(path.join(home, '.claude', 'CLAUDE.md'));
    put(path.join(home, '.claude', 'skills', 's', 'SKILL.md'));
    put(path.join(home, '.claude.json'), '{}');
    put(path.join(home, '.agents', 'skills', 's', 'SKILL.md'));
    internals.settleAgentHome(home);
    for (const gone of ['.config/opencode', '.opencode', '.claude', '.claude.json', '.agents']) {
      assert.equal(exists(path.join(home, gone)), false, `${gone} survived`);
    }
  });

  await check('the tool directories a run installed into stay, and so does the rest of ~/.config', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    put(path.join(home, '.local', 'bin', 'tool'));
    put(path.join(home, '.local', 'share', 'mise', 'installs', 'node', 'bin', 'node'));
    put(path.join(home, '.npm-global', 'bin', 'cli'));
    put(path.join(home, '.cargo', 'bin', 'cargo-thing'));
    put(path.join(home, 'go', 'bin', 'gotool'));
    put(path.join(home, '.config', 'git', 'config'), '[user]\n\tname = mine\n');
    put(path.join(home, '.config', 'opencode', 'plugin', 'x.js'));
    internals.settleAgentHome(home);
    for (const kept of ['.local/bin/tool', '.local/share/mise/installs/node/bin/node', '.npm-global/bin/cli', '.cargo/bin/cargo-thing', 'go/bin/gotool', '.config/git/config']) {
      assert.equal(exists(path.join(home, kept)), true, `${kept} was removed`);
    }
    assert.equal(exists(path.join(home, '.config', 'opencode')), false);
  });

  await check('a link where a directory belongs is removed and never followed: what it points at survives', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    const outside = path.join(s.dir, 'outside');
    put(path.join(outside, 'opencode', 'precious'));
    put(path.join(outside, 'precious-too'));
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(outside, path.join(home, '.config'));
    fs.symlinkSync(outside, path.join(home, '.opencode'));
    fs.symlinkSync(path.join(outside, 'precious-too'), path.join(home, '.claude.json'));
    fs.symlinkSync(outside, path.join(home, '.claude'));
    internals.settleAgentHome(home);
    assert.equal(fs.readFileSync(path.join(outside, 'opencode', 'precious'), 'utf8'), 'x\n');
    assert.equal(fs.readFileSync(path.join(outside, 'precious-too'), 'utf8'), 'x\n');
    for (const name of ['.config', '.opencode', '.claude', '.claude.json']) {
      assert.equal(exists(path.join(home, name)), false, `${name} still there`);
    }
  });

  const template = (() => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor(null);
    internals.settleAgentHome(home);
    return fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
  })();

  await check('the git configuration is the runner\'s template, and a correct one is left as it is', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    internals.settleAgentHome(home);
    const file = path.join(home, '.gitconfig');
    assert.equal(fs.readFileSync(file, 'utf8'), template);
    assert.match(template, /credential "https:\/\/github.com"/);
    const before = fs.statSync(file).ino;
    internals.settleAgentHome(home);
    assert.equal(fs.statSync(file).ino, before);
  });

  await check('a changed git configuration is put back to the template', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    put(path.join(home, '.gitconfig'), '[core]\n\tfsmonitor = touch /tmp/x\n');
    internals.settleAgentHome(home);
    assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), template);
  });

  await check('a FIFO where ~/.gitconfig belongs does not wedge the runner: it is replaced (bounded by a timeout)', () => {
    const s = fresh();
    const home = path.join(s.base, 'acme', 'app');
    fs.mkdirSync(home, { recursive: true });
    execFileSync('mkfifo', [path.join(home, '.gitconfig')]);
    const answer = settleInChild(s, home);
    assert.equal(answer.ok, true, answer.why);
    const stat = fs.lstatSync(path.join(home, '.gitconfig'));
    assert.equal(stat.isFile(), true, 'the FIFO is still there');
    assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), template);
  });

  await check('a link to /dev/zero where ~/.gitconfig belongs is replaced and never read (heap capped at 256 MiB)', () => {
    const s = fresh();
    const home = path.join(s.base, 'acme', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync('/dev/zero', path.join(home, '.gitconfig'));
    const answer = settleInChild(s, home);
    assert.equal(answer.ok, true, answer.why);
    assert.equal(fs.lstatSync(path.join(home, '.gitconfig')).isFile(), true);
    assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), template);
  });

  await check('a link to another file is replaced by a regular one and the file it pointed at is untouched', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    const target = path.join(s.dir, 'target.txt');
    fs.writeFileSync(target, 'not the runner\'s to rewrite\n');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(target, path.join(home, '.gitconfig'));
    internals.settleAgentHome(home);
    assert.equal(fs.lstatSync(path.join(home, '.gitconfig')).isFile(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'not the runner\'s to rewrite\n');
  });

  await check('an oversize file (over 64 KiB) where ~/.gitconfig belongs is replaced, not read', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    put(path.join(home, '.gitconfig'), 'a'.repeat(70_000));
    internals.settleAgentHome(home);
    assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), template);
  });

  await check('a directory where ~/.gitconfig belongs is replaced', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    put(path.join(home, '.gitconfig', 'inside'));
    internals.settleAgentHome(home);
    assert.equal(fs.lstatSync(path.join(home, '.gitconfig')).isFile(), true);
  });

  await check('a link where an owner directory or the home belongs is replaced by a directory', () => {
    const s = fresh();
    useIdentity(s);
    const outside = path.join(s.dir, 'outside-dir');
    put(path.join(outside, 'precious'));
    fs.mkdirSync(s.base, { recursive: true });
    fs.symlinkSync(outside, path.join(s.base, 'acme'));
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    internals.settleAgentHome(home);
    assert.equal(fs.lstatSync(path.join(s.base, 'acme')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'x\n');
    assert.equal(fs.readdirSync(outside).join(','), 'precious', 'the runner wrote through the link');
  });

  await check('closing a home makes it 0700 and tolerates one that is not there', () => {
    const s = fresh();
    useIdentity(s);
    const home = internals.agentHomeFor({ owner: 'acme', name: 'app' });
    internals.settleAgentHome(home);
    fs.chmodSync(home, 0o755);
    internals.closeAgentHome(home);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    internals.closeAgentHome(path.join(s.base, 'acme', 'gone'));
  });

  await check('a start closes every home under the agent home, whoever left them open', () => {
    const s = fresh();
    useIdentity(s);
    const one = internals.agentHomeFor({ owner: 'acme', name: 'one' });
    const two = internals.agentHomeFor({ owner: 'beta', name: 'two' });
    const estate = internals.agentHomeFor(null);
    for (const home of [one, two, estate]) fs.mkdirSync(home, { recursive: true, mode: 0o755 });
    for (const home of [one, two, estate]) fs.chmodSync(home, 0o755);
    internals.closeAllAgentHomes();
    for (const home of [one, two, estate]) assert.equal(fs.statSync(home).mode & 0o777, 0o700, home);
    assert.equal(fs.statSync(s.base).mode & 0o777, 0o711);
  });

  await check('the agent home may not be the runner\'s own home or the root of the file system', () => {
    const s = fresh();
    internals.setIdentity({ mode: 'root', runner: { uid, gid, home: s.base }, agent: { uid, gid, home: s.base } });
    assert.throws(() => internals.settleAgentHome(path.join(s.base, 'acme', 'app')), /runner's own home/);
    internals.setIdentity({ mode: 'root', runner: { uid, gid, home: s.runnerHome }, agent: { uid, gid, home: '/' } });
    assert.throws(() => internals.settleAgentHome('/acme/app'), /agent home/);
  });

  await check('with no account split nothing is removed: a developer\'s own opencode configuration is not the runner\'s to delete', () => {
    const s = fresh();
    internals.setIdentity({ mode: 'none', runner: { uid, gid, home: s.runnerHome }, agent: null });
    put(path.join(s.runnerHome, '.config', 'opencode', 'opencode.json'), '{}');
    put(path.join(s.runnerHome, '.claude', 'CLAUDE.md'));
    internals.settleAgentHome(s.runnerHome);
    assert.equal(exists(path.join(s.runnerHome, '.config', 'opencode', 'opencode.json')), true);
    assert.equal(exists(path.join(s.runnerHome, '.claude', 'CLAUDE.md')), true);
  });

  await check('the switches that stop opencode loading what it finds on its own are set to 1', () => {
    for (const name of [
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
      'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      'OPENCODE_PURE',
    ]) {
      assert.equal(internals.autoLoadSwitches[name], '1', name);
    }
  });

  // The account split asks the process for six capabilities; a start that lacks
  // any of them is one account with a sentence, never a refusal and never a
  // chown that fails later. These drive loadIdentity with the effective set
  // injected, so they need no privilege.
  const accountEnv = {
    SRE_RUNNER_UID: '10001',
    SRE_RUNNER_GID: '10001',
    SRE_RUNNER_HOME: '/home/runner',
    SRE_AGENT_UID: '10002',
    SRE_AGENT_GID: '10002',
    SRE_AGENT_HOME: '/workspace/agent-home',
  };
  const bits = (...numbers) => numbers.reduce((total, bit) => total | (1n << BigInt(bit)), 0n);
  const six = bits(0, 1, 3, 5, 6, 7);

  await check('a root start holding the six capabilities splits accounts', () => {
    const found = internals.loadIdentity(accountEnv, { uid: 0, gid: 0 }, six);
    assert.equal(found.mode, 'root');
    assert.equal(found.degraded, undefined);
  });

  await check('a root start with every capability dropped falls back to one account and names all six', () => {
    const found = internals.loadIdentity(accountEnv, { uid: 0, gid: 0 }, 0n);
    assert.equal(found.mode, 'none');
    for (const name of ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER', 'CAP_KILL', 'CAP_SETGID', 'CAP_SETUID']) {
      assert.match(found.degraded, new RegExp(name), name);
    }
    assert.match(found.degraded, /one account/);
    assert.match(found.degraded, /the agent account split is off/);
  });

  await check('a non-root start that names the agent account but lacks CAP_KILL falls back, naming only that one', () => {
    const env = { ...accountEnv, HOME: '/var/lib/x' };
    const found = internals.loadIdentity(env, { uid: 10003, gid: 10003 }, six & ~bits(5));
    assert.equal(found.mode, 'none');
    assert.match(found.degraded, /lacks CAP_KILL \(/);
    assert.doesNotMatch(found.degraded, /lacks[^(]*CAP_SETUID/);
  });

  await check('a non-root start with the six capabilities is caps mode', () => {
    const found = internals.loadIdentity({ ...accountEnv, HOME: '/var/lib/x' }, { uid: 10003, gid: 10003 }, six);
    assert.equal(found.mode, 'caps');
  });

  await check('a non-root start that names no agent account is the old single account, with no sentence about capabilities', () => {
    const found = internals.loadIdentity({ HOME: '/home/dev' }, { uid: 1000, gid: 1000 }, 0n);
    assert.equal(found.mode, 'none');
    assert.equal(found.degraded, undefined);
  });

  await check('where the capabilities cannot be read the configured split is trusted', () => {
    const found = internals.loadIdentity(accountEnv, { uid: 0, gid: 0 }, null);
    assert.equal(found.mode, 'root');
  });

  await check('a root start without the account ids is still refused, with or without capabilities', () => {
    assert.throws(() => internals.loadIdentity({}, { uid: 0, gid: 0 }, 0n), /SRE_RUNNER_UID/);
    assert.throws(() => internals.loadIdentity({}, { uid: 0, gid: 0 }, six), /SRE_RUNNER_UID/);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.log(`${failed} check${failed === 1 ? '' : 's'} failed`);
    process.exit(1);
  }
})();
