'use strict';
// Per-request hooks and credentials: the settings the runner refuses at start,
// what a hook is given and what it is not, the bounds on a hook, the parsing
// and the refusals of the credentials hook's output, the redaction of what it
// printed, and the role the runner assumes for a request. The request
// lifecycle around them (the report, the agent's environment, the taken-over
// run) is in tests/runner_test.sh.
// Run with `node tests/hooks_test.js`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require(path.resolve(__dirname, '..', 'runner', 'runner.js'));
const { internals } = runner;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
const realPath = process.env.PATH;
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

const DISTINCT = 'tok-Zq9xK2mWvL7pR4nB';
const OTHER = 'sec-Hs8dJf3yTc6uA1eG';

function makeDir(name, mode = 0o755) {
  const dir = path.join(work, `${name}-${(counter += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, mode);
  return dir;
}

function writeHook(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

// A config the way the runner builds one, with SRE_HOOKS_DIR and friends set.
function load(env = {}) {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  const workspace = makeDir('workspace');
  Object.assign(process.env, {
    PATH: realPath,
    HOME: work,
    SRE_SERVER_URL: 'http://127.0.0.1:9',
    SRE_API_KEY: 'sre-agent-poll-hooks-test-key-0000000000000000000000',
    SRE_MODEL: 'openrouter/deepseek/deepseek-v4-pro',
    SRE_WORKSPACE: workspace,
    ...env,
  });
  try {
    return { config: runner.loadConfig(), workspace };
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

function job(extra = {}) {
  return { handoff_id: 'abcd1234-0000-0000-0000-000000000000', repo_full_name: 'acme/app', token: 'handoff-token-not-in-hooks', ...extra };
}

function envOf(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function main() {
  await check('loadCredentialEnv reads NAME=value lines, skipping blanks and comments, and keeps the value whole', () => {
    const env = internals.loadCredentialEnv(`# comment\n\nDB_HOST=db.internal\r\nTOKEN=a=b=c\nEMPTY=\n`);
    assert.deepEqual(env, { DB_HOST: 'db.internal', TOKEN: 'a=b=c', EMPTY: '' });
  });

  await check('loadCredentialEnv refuses every refused name and says which, never the value', () => {
    const refused = ['PATH', 'HOME', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'SRE_API_KEY', 'SRE_ANYTHING', 'OPENCODE_CONFIG', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT'];
    for (const name of refused) {
      let message = null;
      try {
        internals.loadCredentialEnv(`OK_ONE=1\n${name}=${DISTINCT}\n`);
      } catch (error) {
        message = error.message;
      }
      assert.ok(message, `${name} was accepted`);
      assert.ok(message.includes(name), `${name} not named in: ${message}`);
      assert.equal(message.includes(DISTINCT), false, `the value leaked for ${name}`);
    }
  });

  await check('loadCredentialEnv refuses a malformed line without printing it', () => {
    for (const bad of [`lower_case=${DISTINCT}`, `1BAD=${DISTINCT}`, `NOEQUALS${DISTINCT}`, `=${DISTINCT}`, `BAD NAME=${DISTINCT}`]) {
      let message = null;
      try {
        internals.loadCredentialEnv(`GOOD=1\n${bad}\n`);
      } catch (error) {
        message = error.message;
      }
      assert.ok(message, `${bad} was accepted`);
      assert.match(message, /line 2/);
      assert.equal(message.includes(DISTINCT), false, `the line leaked: ${message}`);
    }
  });

  await check('loadCredentialEnv bounds the output and refuses a NUL byte', () => {
    assert.throws(() => internals.loadCredentialEnv(`A=${'x'.repeat(70_000)}`), /bytes/);
    const many = Array.from({ length: 65 }, (_, index) => `V${index}=1`).join('\n');
    assert.throws(() => internals.loadCredentialEnv(many), /more than 64 variables/);
    assert.throws(() => internals.loadCredentialEnv('A=b\0c'), /NUL/);
  });

  await check('a hook gets the request and the runner\'s short environment, and none of the runner\'s credentials', async () => {
    const hooks = makeDir('hooks');
    const seen = path.join(work, 'seen-env');
    writeHook(hooks, 'pre-run', `env > '${seen}'; pwd >> '${seen}.pwd'`);
    process.env.SRE_API_KEY = 'poll-key-not-for-hooks-000000000000000000000000';
    process.env.SRE_GITHUB_TOKEN = 'github-token-not-for-hooks-0000000000000000';
    process.env.OPENROUTER_API_KEY = 'provider-key-not-for-hooks-000000000000000';
    process.env.GH_TOKEN = 'gh-token-not-for-hooks-0000000000000000000';
    process.env.AWS_ACCESS_KEY_ID = 'runner-aws-identity';
    try {
      const { config, workspace } = load({ SRE_HOOKS_DIR: hooks });
      const answer = await internals.runHook('pre-run', job(), {}, { workspace: path.join(workspace, 'repos/acme/app') });
      assert.equal(answer.ok, true);
      const env = envOf(seen);
      assert.equal(env.SRE_HANDOFF_ID, 'abcd1234-0000-0000-0000-000000000000');
      assert.equal(env.SRE_REPO, 'acme/app');
      assert.equal(env.SRE_REQUEST_KIND, 'fix_request');
      assert.equal(env.SRE_WORKSPACE, path.join(workspace, 'repos/acme/app'));
      assert.equal(env.AWS_ACCESS_KEY_ID, 'runner-aws-identity', 'a provisioning hook needs the machine\'s own identity');
      for (const name of ['SRE_API_KEY', 'SRE_GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'GH_TOKEN', 'SRE_HOOKS_DIR']) {
        assert.equal(name in env, false, `${name} reached the hook`);
      }
      assert.equal(fs.readFileSync(`${seen}.pwd`, 'utf8').trim(), fs.realpathSync(hooks), 'a hook starts in its own directory, not in the checkout');
      assert.ok(config.hooks.dir);
    } finally {
      for (const name of ['SRE_API_KEY', 'SRE_GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID']) delete process.env[name];
    }
  });

  await check('the request kind is fix_request, pr_change or test, and a change names its repository', async () => {
    const hooks = makeDir('hooks');
    const seen = path.join(work, 'seen-kind');
    writeHook(hooks, 'pre-run', `printf '%s %s\\n' "$SRE_REQUEST_KIND" "$SRE_REPO" >> '${seen}'`);
    load({ SRE_HOOKS_DIR: hooks });
    await internals.runHook('pre-run', job(), {}, {});
    await internals.runHook('pre-run', job({ repo_full_name: null, kind: 'pr_change', change: { repo_full_name: 'acme/lib', mode: 'replace' } }), {}, {});
    await internals.runHook('pre-run', job({ repo_full_name: null, test: true, test_repo_full_name: null }), {}, {});
    assert.deepEqual(fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean), ['fix_request acme/app', 'pr_change acme/lib', 'test ']);
  });

  await check('a hook that exits non-zero is a failure that names the hook and its status', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'pre-run', 'echo "provisioning failed" >&2; exit 3');
    load({ SRE_HOOKS_DIR: hooks });
    const answer = await internals.runHook('pre-run', job(), {}, {});
    assert.equal(answer.ok, false);
    assert.equal(answer.failure, 'the pre-run hook exited 3');
  });

  await check('a hook that outlives SRE_HOOK_TIMEOUT_SECONDS is stopped with its whole process group', async () => {
    const hooks = makeDir('hooks');
    const pidFile = path.join(work, 'hook-child-pid');
    writeHook(hooks, 'pre-run', `sleep 300 & echo $! > '${pidFile}'; wait`);
    load({ SRE_HOOKS_DIR: hooks, SRE_HOOK_TIMEOUT_SECONDS: '1' });
    const started = Date.now();
    const answer = await internals.runHook('pre-run', job(), {}, {});
    assert.equal(answer.ok, false);
    assert.equal(answer.failure, 'the pre-run hook did not finish within 1 seconds and was stopped');
    assert.ok(Date.now() - started < 15_000);
    const child = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    let alive = true;
    for (let tries = 0; tries < 40 && alive; tries += 1) {
      try {
        process.kill(child, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the hook\'s child outlived the stop');
  });

  await check('a missing hook is skipped, and with no SRE_HOOKS_DIR nothing runs at all', async () => {
    const hooks = makeDir('hooks');
    load({ SRE_HOOKS_DIR: hooks });
    assert.deepEqual(await internals.runHook('credentials', job(), {}, {}), { ran: false, ok: true });
    load({});
    assert.deepEqual(await internals.runHook('pre-run', job(), {}, {}), { ran: false, ok: true });
  });

  await check('prepareRequestEnv: a failing pre-run fails the request with its name and runs no credentials hook', async () => {
    const hooks = makeDir('hooks');
    const marker = path.join(work, 'credentials-ran');
    writeHook(hooks, 'pre-run', 'exit 1');
    writeHook(hooks, 'credentials', `touch '${marker}'; echo A=1`);
    const { config } = load({ SRE_HOOKS_DIR: hooks });
    await assert.rejects(() => internals.prepareRequestEnv(config, job(), {}), /the pre-run hook exited 1/);
    assert.equal(fs.existsSync(marker), false);
  });

  await check('prepareRequestEnv: a failing credentials hook fails the request with its name', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'credentials', 'exit 7');
    const { config } = load({ SRE_HOOKS_DIR: hooks });
    await assert.rejects(() => internals.prepareRequestEnv(config, job(), {}), /the credentials hook exited 7/);
  });

  await check('prepareRequestEnv: a refused name fails the request naming the variable and never the value', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'credentials', `echo 'GH_TOKEN=${DISTINCT}'`);
    const { config } = load({ SRE_HOOKS_DIR: hooks });
    let message = null;
    try {
      await internals.prepareRequestEnv(config, job(), {});
    } catch (error) {
      message = error.message;
    }
    assert.ok(message);
    assert.match(message, /credentials hook/);
    assert.match(message, /GH_TOKEN/);
    assert.equal(message.includes(DISTINCT), false);
  });

  await check('prepareRequestEnv: accepted credentials are handed back and redacted until the request ends', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'credentials', `echo 'DB_PASSWORD=${DISTINCT}'; echo 'REGION=eu'`);
    const { config } = load({ SRE_HOOKS_DIR: hooks });
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    let prepared;
    try {
      prepared = await internals.prepareRequestEnv(config, job(), {});
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(prepared.extraEnv, { DB_PASSWORD: DISTINCT, REGION: 'eu' });
    assert.equal(prepared.awsReplaced, false);
    assert.equal(lines.join('').includes(DISTINCT), false, 'the value was logged');
    assert.ok(lines.join('').includes('DB_PASSWORD'), 'the names are logged');
    assert.equal(internals.redact(`the agent said ${DISTINCT}`), 'the agent said [redacted]');
    assert.equal(internals.redact('region eu stays'), 'region eu stays', 'a short value is not a credential');
    internals.clearRequestSecrets();
    assert.equal(internals.redact(`the agent said ${DISTINCT}`), `the agent said ${DISTINCT}`);
  });

  await check('a hook\'s own output is logged, redacted of the credentials printed for the same request', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'credentials', `echo 'DB_PASSWORD=${DISTINCT}'`);
    writeHook(hooks, 'post-run', `echo "cleaning up ${DISTINCT}"; echo "from stderr ${DISTINCT}" >&2`);
    const { config } = load({ SRE_HOOKS_DIR: hooks });
    const lines = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await internals.prepareRequestEnv(config, job(), {});
      await internals.runHook('post-run', job(), {}, {});
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
      internals.clearRequestSecrets();
    }
    const text = lines.join('');
    assert.ok(text.includes('hook post-run: cleaning up [redacted]'), text);
    assert.equal(text.includes(DISTINCT), false);
  });

  await check('a failing post-run is reported to the caller as a failure and throws nothing', async () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'post-run', 'exit 9');
    load({ SRE_HOOKS_DIR: hooks });
    const answer = await internals.runHook('post-run', job(), {}, {});
    assert.equal(answer.ok, false);
    assert.equal(answer.failure, 'the post-run hook exited 9');
  });

  await check('the built-in role: with agent AWS access the runner assumes it for the request, and only then', async () => {
    const bin = makeDir('bin');
    const calls = path.join(work, 'aws-calls');
    fs.writeFileSync(
      path.join(bin, 'aws'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '{"Credentials":{"AccessKeyId":"ASIAEXAMPLE","SecretAccessKey":"${OTHER}","SessionToken":"${DISTINCT}"}}\\n'\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${bin}:${realPath}`;
    try {
      const arn = 'arn:aws:iam::123456789012:role/sre-agent-fix';
      const on = load({ SRE_AGENT_AWS_ROLE_ARN: arn, SRE_AGENT_AWS_ACCESS: '1' });
      const prepared = await internals.prepareRequestEnv(on.config, job(), {});
      assert.deepEqual(prepared.extraEnv, { AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE', AWS_SECRET_ACCESS_KEY: OTHER, AWS_SESSION_TOKEN: DISTINCT });
      assert.equal(prepared.awsReplaced, true);
      assert.equal(fs.readFileSync(calls, 'utf8').trim(), `sts assume-role --role-arn ${arn} --role-session-name sre-abcd1234 --duration-seconds 3600 --output json`);
      assert.equal(internals.redact(`x ${DISTINCT} y ${OTHER}`), 'x [redacted] y [redacted]');
      internals.clearRequestSecrets();
      fs.rmSync(calls);
      const off = load({ SRE_AGENT_AWS_ROLE_ARN: arn });
      const idle = await internals.prepareRequestEnv(off.config, job(), {});
      assert.deepEqual(idle.extraEnv, {});
      assert.equal(idle.awsReplaced, false);
      assert.equal(fs.existsSync(calls), false, 'the role was assumed for an agent that is not given AWS access');
    } finally {
      process.env.PATH = realPath;
      internals.clearRequestSecrets();
    }
  });

  await check('the built-in role: a failed assume fails the request with the CLI\'s words', async () => {
    const bin = makeDir('bin');
    fs.writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash\necho "An error occurred (AccessDenied) ${DISTINCT}" >&2\nexit 254\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${realPath}`;
    try {
      const hooks = makeDir('hooks');
      writeHook(hooks, 'credentials', 'true');
      const arn = 'arn:aws:iam::123456789012:role/sre-agent-fix';
      const { config } = load({ SRE_AGENT_AWS_ROLE_ARN: arn, SRE_AGENT_AWS_ACCESS: '1', SRE_HOOKS_DIR: hooks });
      let message = null;
      try {
        await internals.prepareRequestEnv(config, job(), {});
      } catch (error) {
        message = error.message;
      }
      assert.ok(message);
      assert.match(message, /SRE_AGENT_AWS_ROLE_ARN could not be assumed/);
      assert.match(message, /AccessDenied/);
    } finally {
      process.env.PATH = realPath;
    }
  });

  await check('the built-in role: a variable the credentials hook prints wins over the role\'s', async () => {
    const bin = makeDir('bin');
    fs.writeFileSync(
      path.join(bin, 'aws'),
      `#!/usr/bin/env bash\nprintf '{"Credentials":{"AccessKeyId":"ASIAEXAMPLE","SecretAccessKey":"${OTHER}","SessionToken":"${DISTINCT}"}}\\n'\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${bin}:${realPath}`;
    try {
      const hooks = makeDir('hooks');
      writeHook(hooks, 'credentials', 'echo AWS_ACCESS_KEY_ID=from-the-hook');
      const { config } = load({ SRE_AGENT_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/sre-agent-fix', SRE_AGENT_AWS_ACCESS: '1', SRE_HOOKS_DIR: hooks });
      const prepared = await internals.prepareRequestEnv(config, job(), {});
      assert.equal(prepared.extraEnv.AWS_ACCESS_KEY_ID, 'from-the-hook');
      assert.equal(prepared.extraEnv.AWS_SESSION_TOKEN, DISTINCT);
    } finally {
      process.env.PATH = realPath;
      internals.clearRequestSecrets();
    }
  });

  await check('the settings the runner refuses to start with', () => {
    const hooks = makeDir('hooks');
    writeHook(hooks, 'pre-run', 'true');
    assert.throws(() => load({ SRE_HOOKS_DIR: 'hooks' }), /not an absolute path/);
    assert.throws(() => load({ SRE_HOOKS_DIR: path.join(work, 'does-not-exist') }), /not a directory/);
    assert.throws(() => load({ SRE_HOOK_TIMEOUT_SECONDS: '0' }), /SRE_HOOK_TIMEOUT_SECONDS/);
    assert.throws(() => load({ SRE_HOOK_TIMEOUT_SECONDS: 'soon' }), /SRE_HOOK_TIMEOUT_SECONDS/);
    assert.throws(() => load({ SRE_AGENT_AWS_ROLE_ARN: 'not-an-arn' }), /SRE_AGENT_AWS_ROLE_ARN/);
    fs.chmodSync(path.join(hooks, 'pre-run'), 0o644);
    assert.throws(() => load({ SRE_HOOKS_DIR: hooks }), /pre-run hook in SRE_HOOKS_DIR is not executable/);
    fs.chmodSync(path.join(hooks, 'pre-run'), 0o755);
    assert.equal(load({ SRE_HOOKS_DIR: hooks }).config.hooks.dir, fs.realpathSync(hooks));
  });

  await check('a hooks directory on the workspace is refused, however it is spelled', () => {
    const workspace = makeDir('ws-for-hooks');
    const inside = path.join(workspace, 'hooks');
    fs.mkdirSync(inside);
    assert.throws(() => load({ SRE_WORKSPACE: workspace, SRE_HOOKS_DIR: inside }), /on the workspace/);
    assert.throws(() => load({ SRE_WORKSPACE: workspace, SRE_HOOKS_DIR: workspace }), /on the workspace/);
    const link = path.join(work, `link-to-ws-hooks-${counter}`);
    fs.symlinkSync(inside, link);
    assert.throws(() => load({ SRE_WORKSPACE: workspace, SRE_HOOKS_DIR: link }), /on the workspace/);
    const outside = makeDir('outside-hooks');
    assert.equal(load({ SRE_WORKSPACE: workspace, SRE_HOOKS_DIR: outside }).config.hooks.dir, fs.realpathSync(outside));
  });

  await check('with an agent account, a hooks directory or hook the agent could write is refused', () => {
    const me = { uid: process.getuid(), gid: process.getgid() };
    const layout = { workspace: makeDir('ws-agent') };
    const env = (dir) => ({ SRE_HOOKS_DIR: dir });
    const owned = makeDir('hooks');
    assert.throws(() => internals.loadHookSettings(env(owned), layout, me), /owned by the agent account/);
    const stranger = { uid: me.uid + 4242, gid: me.gid + 4242 };
    const fine = makeDir('hooks', 0o755);
    writeHook(fine, 'pre-run', 'true');
    assert.equal(internals.loadHookSettings(env(fine), layout, stranger).dir, fs.realpathSync(fine));
    const open = makeDir('hooks', 0o777);
    assert.throws(() => internals.loadHookSettings(env(open), layout, stranger), /writable by every account/);
    const grouped = makeDir('hooks', 0o775);
    assert.throws(() => internals.loadHookSettings(env(grouped), layout, { uid: me.uid + 4242, gid: me.gid }), /writable by the agent's group/);
    const hookOpen = makeDir('hooks', 0o755);
    writeHook(hookOpen, 'credentials', 'true');
    fs.chmodSync(path.join(hookOpen, 'credentials'), 0o777);
    assert.throws(() => internals.loadHookSettings(env(hookOpen), layout, stranger), /writable by every account/);
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
