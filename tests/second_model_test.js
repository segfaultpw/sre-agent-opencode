'use strict';
// The runner's second model: the provider table it shares with
// scripts/provider_env.sh, the one provider key each run's environment holds, the
// start refusals and warnings of SRE_MODEL_FALLBACK and SRE_MODEL_FALLBACK_KEY,
// the second key as a held secret, and the decision to start the second run.
// Run with `node tests/second_model_test.js`.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runnerPath = path.resolve(__dirname, '..', 'runner', 'runner.js');
const providerScript = path.resolve(__dirname, '..', 'scripts', 'provider_env.sh');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'second-model-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
// Assembled at run time: a key shaped literal in the repository trips push protection.
const POLL_KEY = `sre-agent-poll-${'1'.repeat(48)}`;
const FIRST_KEY = `sk-ant-first-${'2'.repeat(40)}`;
const SECOND_KEY = `sk-openai-second-${'3'.repeat(40)}`;
const HOOK_KEY = `sk-hook-${'4'.repeat(40)}`;

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

// The runner as production loads it, under an environment of this test's own.
// Answers the module, what loadConfig returned (or the error it threw), and
// everything the runner wrote to stdout and stderr while it did.
let loaded = 0;
function load(extra = {}, { throwing = false } = {}) {
  loaded += 1;
  const workspace = path.join(work, `workspace-${loaded}`);
  fs.mkdirSync(workspace, { recursive: true });
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    PATH: saved.PATH,
    HOME: work,
    SRE_SERVER_URL: 'http://127.0.0.1:1',
    SRE_API_KEY: POLL_KEY,
    SRE_MODEL: 'anthropic/claude-sonnet-4-5',
    ANTHROPIC_API_KEY: FIRST_KEY,
    SRE_WORKSPACE: workspace,
    SRE_RUNNER_INSTANCE: 'runner-1',
    SRE_ONCE: '1',
    ...extra,
  });
  for (const [name, value] of Object.entries(extra)) if (value === undefined) delete process.env[name];
  const written = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() : true;
  };
  process.stderr.write = process.stdout.write;
  let config = null;
  let error = null;
  let runner;
  try {
    delete require.cache[runnerPath];
    runner = require(runnerPath);
    try {
      config = runner.loadConfig();
    } catch (thrown) {
      error = thrown;
    }
    const env = { ...process.env };
    return { runner, config, error, output: written.join(''), env, redact: runner.internals.redact, held: runner.internals.heldSecrets() };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    if (throwing && error) throw error;
  }
}

function scriptTable() {
  const names = spawnSync('bash', [providerScript, '--all'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const prefixes = [];
  // The script answers one variable for a model; the prefixes are read from its table.
  const source = fs.readFileSync(providerScript, 'utf8');
  const table = /table='([^']*)'/.exec(source)[1];
  for (const line of table.split('\n')) prefixes.push(line.split(' ')[0]);
  return { names, prefixes };
}

async function main() {
  const runner = load().runner;
  const { providerKeyVariable, runEnvForModel, secondModelDecision } = runner.internals;

  await check('the table is the script\'s: every pair, the same variables in the same order', async () => {
    const { names, prefixes } = scriptTable();
    assert.equal(prefixes.length, 19);
    assert.deepEqual(runner.PROVIDER_KEY_VARIABLES, names);
    assert.deepEqual(Object.keys(runner.PROVIDER_KEY_TABLE), prefixes);
    for (const prefix of prefixes) {
      const answer = spawnSync('bash', [providerScript, `${prefix}/some-model`], { encoding: 'utf8' });
      assert.equal(answer.status, 0, prefix);
      assert.equal(runner.PROVIDER_KEY_TABLE[prefix], answer.stdout.trim(), prefix);
    }
    assert.ok(Object.isFrozen(runner.PROVIDER_KEY_TABLE));
  });

  await check('providerKeyVariable maps a prefix and answers null otherwise', async () => {
    assert.equal(providerKeyVariable('anthropic/claude-sonnet-4-5'), 'ANTHROPIC_API_KEY');
    assert.equal(providerKeyVariable('openrouter/deepseek/deepseek-v4-pro'), 'OPENROUTER_API_KEY');
    assert.equal(providerKeyVariable('fireworks-ai/accounts/fireworks/models/x'), 'FIREWORKS_API_KEY');
    for (const model of ['nope/x', 'anthropic', '', '/x', 'constructor/x', '__proto__/x', 'toString/x', undefined, null, 5]) {
      assert.equal(providerKeyVariable(model), null, String(model));
    }
  });

  await check('one key per run: a mapped first model holds its own key and nothing else of the table', async () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'a-key', OPENAI_API_KEY: 'o-key', GROQ_API_KEY: 'g-key', SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: 'second-key', OTHER: 'kept' };
    const config = { model: 'anthropic/claude-sonnet-4-5', fallbackModel: 'openai/gpt-5' };
    const first = runEnvForModel(env, config.model, config, {});
    assert.equal(first.ANTHROPIC_API_KEY, 'a-key');
    for (const name of ['OPENAI_API_KEY', 'GROQ_API_KEY', 'SRE_MODEL_FALLBACK', 'SRE_MODEL_FALLBACK_KEY']) assert.equal(name in first, false, name);
    assert.equal(first.OTHER, 'kept');
    assert.equal(first.PATH, '/bin');
    const second = runEnvForModel(env, config.fallbackModel, config, {}, { second: true });
    assert.equal(second.OPENAI_API_KEY, 'second-key');
    for (const name of ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'SRE_MODEL_FALLBACK', 'SRE_MODEL_FALLBACK_KEY']) assert.equal(name in second, false, name);
    assert.equal(second.OTHER, 'kept');
    assert.equal(env.ANTHROPIC_API_KEY, 'a-key', 'the environment it was given is not changed');
    assert.equal(env.SRE_MODEL_FALLBACK_KEY, 'second-key');
  });

  await check('one key per run: the same provider on another account gives the second run the fallback key under the same variable', async () => {
    const env = { ANTHROPIC_API_KEY: 'first-account', SRE_MODEL_FALLBACK: 'anthropic/claude-haiku-4-5', SRE_MODEL_FALLBACK_KEY: 'second-account' };
    const config = { model: 'anthropic/claude-sonnet-4-5', fallbackModel: 'anthropic/claude-haiku-4-5' };
    assert.equal(runEnvForModel(env, config.model, config, {}).ANTHROPIC_API_KEY, 'first-account');
    assert.equal(runEnvForModel(env, config.fallbackModel, config, {}, { second: true }).ANTHROPIC_API_KEY, 'second-account');
  });

  await check('one key per run: a hook\'s key reaches the first run that reads it, is left out of a first run that does not, and never reaches the second run', async () => {
    const config = { model: 'anthropic/claude-sonnet-4-5', fallbackModel: 'openai/gpt-5' };
    const env = { ANTHROPIC_API_KEY: 'a-key', SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: 'second-key' };
    const left = [];
    const first = runEnvForModel(env, config.model, config, { OPENAI_API_KEY: 'hook-openai', ANTHROPIC_API_KEY: 'hook-anthropic', AWS_REGION: 'eu-west-1' }, { leftOut: left });
    assert.equal(first.ANTHROPIC_API_KEY, 'hook-anthropic', 'a hook\'s key wins in the run it was set for');
    assert.equal('OPENAI_API_KEY' in first, false, 'an openai key is left out of an anthropic run');
    assert.equal(first.AWS_REGION, 'eu-west-1', 'a name that is not a provider key is applied');
    assert.deepEqual(left, ['OPENAI_API_KEY']);
    const secondLeft = [];
    const second = runEnvForModel(env, config.fallbackModel, config, { OPENAI_API_KEY: 'hook-openai', ANTHROPIC_API_KEY: 'hook-anthropic', AWS_REGION: 'eu-west-1' }, { second: true, leftOut: secondLeft });
    assert.equal(second.OPENAI_API_KEY, 'second-key', 'a provider key the hook printed is the first run\'s: the second run holds SRE_MODEL_FALLBACK_KEY');
    assert.equal('ANTHROPIC_API_KEY' in second, false);
    assert.equal(second.AWS_REGION, 'eu-west-1', 'what is not a provider key still reaches the second run');
    assert.deepEqual(secondLeft, [], 'nothing is said about a value that was never meant for the second run');
  });

  await check('one key per run: a hook\'s value for the variable both models read is the first run\'s, and the second run keeps SRE_MODEL_FALLBACK_KEY', async () => {
    const config = { model: 'anthropic/claude-sonnet-4-5', fallbackModel: 'anthropic/claude-haiku-4-5' };
    const env = { ANTHROPIC_API_KEY: 'a-key', SRE_MODEL_FALLBACK: config.fallbackModel, SRE_MODEL_FALLBACK_KEY: 'second-account' };
    const hook = { ANTHROPIC_API_KEY: 'hook-account' };
    assert.equal(runEnvForModel(env, config.model, config, hook).ANTHROPIC_API_KEY, 'hook-account');
    assert.equal(runEnvForModel(env, config.fallbackModel, config, hook, { second: true }).ANTHROPIC_API_KEY, 'second-account');
  });

  await check('one key per run: an unmapped first model keeps every provider key variable the runner holds, and never the second model\'s pair', async () => {
    const config = { model: 'amazon-bedrock/some-model', fallbackModel: 'openai/gpt-5' };
    const env = { ANTHROPIC_API_KEY: 'a-key', OPENAI_API_KEY: 'o-key', AWS_REGION: 'us-east-1', SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: 'second-key' };
    const first = runEnvForModel(env, config.model, config, { SOME_KEY: 'hooked', GROQ_API_KEY: 'hook-groq' });
    assert.equal(first.ANTHROPIC_API_KEY, 'a-key');
    assert.equal(first.OPENAI_API_KEY, 'o-key');
    assert.equal(first.GROQ_API_KEY, 'hook-groq');
    assert.equal(first.SOME_KEY, 'hooked');
    assert.equal('SRE_MODEL_FALLBACK' in first, false);
    assert.equal('SRE_MODEL_FALLBACK_KEY' in first, false);
    const second = runEnvForModel(env, config.fallbackModel, config, {}, { second: true });
    assert.deepEqual(Object.keys(second).filter((name) => runner.PROVIDER_KEY_VARIABLES.includes(name)), ['OPENAI_API_KEY']);
    assert.equal(second.OPENAI_API_KEY, 'second-key');
  });

  await check('a start with neither variable is a start with no second model', async () => {
    const answer = load();
    assert.equal(answer.error, null);
    assert.equal(answer.config.fallbackModel, null);
    assert.equal(answer.config.primaryKeyVariable, 'ANTHROPIC_API_KEY');
    assert.equal(answer.config.fallbackKeyVariable, null);
    assert.doesNotMatch(answer.output, /second model|SRE_MODEL_FALLBACK/);
  });

  await check('a start with both reads the second model and its variable, and keeps the key in the environment alone', async () => {
    const answer = load({ SRE_MODEL_FALLBACK: ' openai/gpt-5 ', SRE_MODEL_FALLBACK_KEY: `${SECOND_KEY}\n` });
    assert.equal(answer.error, null, answer.error && answer.error.message);
    assert.equal(answer.config.fallbackModel, 'openai/gpt-5');
    assert.equal(answer.config.fallbackKeyVariable, 'OPENAI_API_KEY');
    assert.equal(answer.env.SRE_MODEL_FALLBACK_KEY, SECOND_KEY, 'trimmed in the environment');
    assert.equal(JSON.stringify(answer.config).includes(SECOND_KEY), false, 'no copy of the key in the config');
  });

  await check('the start refuses what it cannot honour, in the plan\'s sentences, and prints no key', async () => {
    const prefixes = scriptTable().prefixes.join(', ');
    const refusals = [
      ['one without the other (the model alone)', { SRE_MODEL_FALLBACK: 'openai/gpt-5' }, 'SRE_MODEL_FALLBACK and SRE_MODEL_FALLBACK_KEY go together: set both to give the runner a second model, or neither (the key is not printed)'],
      ['one without the other (the key alone)', { SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK and SRE_MODEL_FALLBACK_KEY go together: set both to give the runner a second model, or neither (the key is not printed)'],
      ['a malformed model (no slash)', { SRE_MODEL_FALLBACK: 'gpt-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK must be provider/model, for example openai/gpt-5'],
      ['a malformed model (upper case prefix)', { SRE_MODEL_FALLBACK: 'OpenAI/gpt-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK must be provider/model, for example openai/gpt-5'],
      ['a malformed model (a line break inside)', { SRE_MODEL_FALLBACK: 'openai/gpt\n-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK must be provider/model, for example openai/gpt-5'],
      ['a malformed model (a space inside)', { SRE_MODEL_FALLBACK: 'openai/gpt 5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK must be provider/model, for example openai/gpt-5'],
      ['a malformed model (nothing after the slash)', { SRE_MODEL_FALLBACK: 'openai/', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, 'SRE_MODEL_FALLBACK must be provider/model, for example openai/gpt-5'],
      ['an unmapped prefix', { SRE_MODEL_FALLBACK: 'amazon-bedrock/some-model', SRE_MODEL_FALLBACK_KEY: SECOND_KEY }, `SRE_MODEL_FALLBACK names the provider prefix amazon-bedrock, which the runner does not map, so it cannot tell which variable its key goes in; use one of ${prefixes}`],
      ['the same model with the same key', { SRE_MODEL_FALLBACK: 'anthropic/claude-sonnet-4-5', SRE_MODEL_FALLBACK_KEY: FIRST_KEY }, 'SRE_MODEL_FALLBACK is SRE_MODEL with the same key, so whatever refuses the first would refuse the second; give the second model another key or another model (the keys are not printed)'],
    ];
    for (const [label, extra, sentence] of refusals) {
      const answer = load(extra);
      assert.ok(answer.error, `${label}: the start was not refused`);
      assert.equal(answer.error.fatal, true, label);
      assert.equal(answer.error.message, sentence, label);
      for (const key of [FIRST_KEY, SECOND_KEY, POLL_KEY]) assert.equal(`${answer.error.message}${answer.output}`.includes(key), false, `${label}: a key was printed`);
    }
  });

  await check('only the second model\'s prefix is judged: an unmapped first model starts', async () => {
    const answer = load({ SRE_MODEL: 'amazon-bedrock/some-model', ANTHROPIC_API_KEY: undefined });
    assert.equal(answer.error, null, answer.error && answer.error.message);
    assert.equal(answer.config.primaryKeyVariable, null);
  });

  await check('the same model with another key starts, and the same key with another model starts, with a warning', async () => {
    const sameModel = load({ SRE_MODEL_FALLBACK: 'anthropic/claude-sonnet-4-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY });
    assert.equal(sameModel.error, null, sameModel.error && sameModel.error.message);
    assert.doesNotMatch(sameModel.output, /the second model uses the same key as the first/);
    const sameKey = load({ SRE_MODEL_FALLBACK: 'anthropic/claude-haiku-4-5', SRE_MODEL_FALLBACK_KEY: FIRST_KEY });
    assert.equal(sameKey.error, null, sameKey.error && sameKey.error.message);
    assert.match(sameKey.output, / warn the second model uses the same key as the first, so a key, credit or quota refusal of the first will refuse the second too; it still helps when the first model is not found or rate limited\n/);
  });

  await check('the start warns: the hooks directory, a key shared by the two models, and an unmapped first model; no key value in any line', async () => {
    const hooks = path.join(work, 'hooks');
    fs.mkdirSync(hooks, { recursive: true, mode: 0o700 });
    const withHooks = load({ SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY, SRE_HOOKS_DIR: hooks });
    assert.equal(withHooks.error, null, withHooks.error && withHooks.error.message);
    assert.match(withHooks.output, / warn a second model is configured \(openai\/gpt-5\); the start check of its key cannot see keys the credentials hook sets for a request\n/);
    const without = load({ SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY });
    assert.doesNotMatch(without.output, /the start check of its key cannot see/);
    const unmapped = load({ SRE_MODEL: 'amazon-bedrock/some-model', ANTHROPIC_API_KEY: undefined });
    assert.match(unmapped.output, / warn SRE_MODEL's prefix amazon-bedrock is not one the runner maps, so its runs keep every provider key variable the runner holds; a mapped provider's run gets only its own key\n/);
    assert.doesNotMatch(load().output, /prefix .* is not one the runner maps/);
    for (const answer of [withHooks, without, unmapped]) {
      for (const key of [FIRST_KEY, SECOND_KEY, POLL_KEY]) assert.equal(answer.output.includes(key), false, 'a key was printed');
    }
  });

  await check('the second key is a held secret: redacted by value, in the held list, and in the scrubber\'s view', async () => {
    const answer = load({ SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: SECOND_KEY });
    assert.equal(answer.error, null, answer.error && answer.error.message);
    assert.equal(answer.redact(`the gateway said ${SECOND_KEY} twice: ${SECOND_KEY}`), 'the gateway said [redacted] twice: [redacted]');
    assert.ok(answer.held.includes(SECOND_KEY));
    assert.ok(answer.held.includes(FIRST_KEY));
    const scrubbed = require(path.resolve(__dirname, '..', 'runner', 'provider_refusal.js')).scrub(`bad key ${encodeURIComponent(SECOND_KEY)} and ${JSON.stringify(SECOND_KEY).slice(1, -1)}`, answer.redact, answer.held);
    assert.equal(scrubbed.includes(SECOND_KEY), false);
    assert.equal(scrubbed.includes(encodeURIComponent(SECOND_KEY)), false);
  });

  await check('a line break inside the second key refuses the start and the value is not printed', async () => {
    const answer = load({ SRE_MODEL_FALLBACK: 'openai/gpt-5', SRE_MODEL_FALLBACK_KEY: 'first-half-of-it\nsecond-half-of-it' });
    assert.equal(answer.error.fatal, true);
    assert.equal(answer.error.message, 'SRE_MODEL_FALLBACK_KEY has a line break inside its value, so it cannot be one secret; set it again as a single line (the value is not printed)');
  });

  await check('secondModelDecision: every condition, one at a time', async () => {
    const config = { fallbackModel: 'openai/gpt-5', runTimeoutMs: 1_800_000 };
    const refusal = { class: 'billing', status: 400, message: 'm' };
    const first = { toolNames: ['read', 'glob', 'grep', 'list'], toolNamesOverflow: false };
    const startedAt = 1_000_000;
    const base = { config, first, refusal, quiet: true, startedAt, now: startedAt + 1000 };
    assert.deepEqual(secondModelDecision(base), { try: true, notTried: null });
    assert.deepEqual(secondModelDecision({ ...base, first: { toolNames: [], toolNamesOverflow: false } }), { try: true, notTried: null }, 'a run that used no tool');
    assert.deepEqual(secondModelDecision({ ...base, refusal: null }), { try: false, notTried: null }, 'not refused');
    assert.deepEqual(secondModelDecision({ ...base, config: { ...config, fallbackModel: null } }), { try: false, notTried: null }, 'no second model');
    assert.deepEqual(secondModelDecision({ ...base, quiet: false }), { try: false, notTried: null }, 'processes of the agent are left');
    for (const tool of ['edit', 'write', 'bash', 'patch', 'webfetch', 'task', '(unnamed)']) {
      assert.deepEqual(secondModelDecision({ ...base, first: { toolNames: ['read', tool], toolNamesOverflow: false } }), { try: false, notTried: 'changed' }, tool);
    }
    assert.deepEqual(secondModelDecision({ ...base, first: { toolNames: ['read'], toolNamesOverflow: true } }), { try: false, notTried: 'changed' }, 'more tools than were counted');
    const left = (milliseconds) => ({ ...base, now: startedAt + config.runTimeoutMs - milliseconds });
    assert.deepEqual(secondModelDecision(left(119_999)), { try: false, notTried: 'time' }, 'just under two minutes left');
    assert.deepEqual(secondModelDecision(left(120_000)), { try: true, notTried: null }, 'exactly two minutes left');
    assert.deepEqual(secondModelDecision(left(600_000)), { try: true, notTried: null });
    assert.deepEqual(secondModelDecision({ ...left(60_000), first: { toolNames: ['bash'], toolNamesOverflow: false } }), { try: false, notTried: 'changed' }, 'a tool is told before the time');
    assert.deepEqual(secondModelDecision({ ...base, config: { ...config, runTimeoutMs: 100_000 } }), { try: false, notTried: 'time' }, 'a run limit under two minutes never has room');
  });

  await check('workspaceUnchanged: the checkout is the base commit, byte for byte, and nothing else of the agent\'s is left', async () => {
    const { workspaceUnchanged, setIdentity, openMemory } = runner.internals;
    setIdentity({ mode: 'none', runner: null, agent: null });
    const git = (cwd, ...args) => {
      const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
      assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
      return done.stdout.trim();
    };
    // A checkout the way the runner makes one: the git directory is a separate one the
    // agent never holds, the tree is only files, the base commit is what HEAD is.
    const make = (label) => {
      const root = path.join(work, `proof-${label}`);
      const dir = path.join(root, 'tree');
      const gitdir = path.join(root, 'gitdir');
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main', `--separate-git-dir=${gitdir}`);
      fs.rmSync(path.join(dir, '.git'), { force: true });
      fs.writeFileSync(path.join(dir, 'README.md'), 'the repository\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\n');
      fs.writeFileSync(path.join(dir, 'opencode.json'), '{}\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'app.txt'), 'app\n');
      const named = (...args) => git(dir, `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args);
      named('add', '-A');
      named('commit', '-q', '-m', 'base');
      const baseSha = named('rev-parse', 'HEAD');
      // The runner takes the repository's own opencode configuration out of the tree and marks it so.
      named('update-index', '--skip-worktree', 'opencode.json');
      fs.rmSync(path.join(dir, 'opencode.json'));
      fs.mkdirSync(path.join(dir, '.opencode', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.opencode', 'agents', 'sre-fix.md'), 'the agent\n');
      const workspace = { dir, gitdir, cleanUrl: 'https://github.com/acme/app.git', baseSha, repo: { owner: 'acme', name: 'app', fullName: 'acme/app' } };
      return { workspace, dir, named };
    };
    const unchanged = (made, mem = null) => workspaceUnchanged(made.workspace, mem, made.workspace.repo);

    const clean = make('clean');
    assert.equal(await unchanged(clean), true, 'the base tree, with the runner\'s own files, is unchanged');
    assert.equal(await unchanged(clean), true, 'and asking again changes nothing');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('sre-agent-proof-')).length, 0, 'the throwaway index is removed');

    const touched = make('touched');
    fs.utimesSync(path.join(touched.dir, 'README.md'), new Date(), new Date(Date.now() + 5000));
    assert.equal(await unchanged(touched), true, 'a file whose time moved and whose bytes did not is unchanged');

    const cases = {
      'an edited file': (m) => fs.appendFileSync(path.join(m.dir, 'README.md'), 'one more line\n'),
      'a new file': (m) => fs.writeFileSync(path.join(m.dir, 'new.txt'), 'x\n'),
      'a deleted file': (m) => fs.rmSync(path.join(m.dir, 'src', 'app.txt')),
      'a changed mode': (m) => fs.chmodSync(path.join(m.dir, 'README.md'), 0o755),
      'a file under an ignored path': (m) => {
        fs.mkdirSync(path.join(m.dir, 'cache'));
        fs.writeFileSync(path.join(m.dir, 'cache', 'out.txt'), 'x\n');
      },
      'a file under a path the git directory ignores': (m) => {
        fs.appendFileSync(path.join(m.workspace.gitdir, 'info', 'exclude'), 'build/\n');
        fs.mkdirSync(path.join(m.dir, 'build'));
        fs.writeFileSync(path.join(m.dir, 'build', 'out.txt'), 'x\n');
      },
      'an empty directory\'s file in a new place': (m) => {
        fs.mkdirSync(path.join(m.dir, 'deep', 'er'), { recursive: true });
        fs.writeFileSync(path.join(m.dir, 'deep', 'er', 'file'), 'x\n');
      },
      'a file in the base replaced by a link': (m) => {
        fs.rmSync(path.join(m.dir, 'README.md'));
        fs.symlinkSync('/etc/hostname', path.join(m.dir, 'README.md'));
      },
      'a nested repository': (m) => {
        fs.mkdirSync(path.join(m.dir, 'sub'));
        git(path.join(m.dir, 'sub'), 'init', '-q');
      },
    };
    for (const [label, change] of Object.entries(cases)) {
      const made = make(label.replace(/[^a-z]+/g, '-'));
      change(made);
      assert.equal(await unchanged(made), false, label);
    }

    const staged = make('staged');
    fs.writeFileSync(path.join(staged.dir, 'new.txt'), 'x\n');
    staged.named('add', 'new.txt');
    assert.equal(await unchanged(staged), false, 'an index that differs from the base commit is a difference');

    const moved = make('moved');
    moved.workspace.baseSha = '0'.repeat(40);
    assert.equal(await unchanged(moved), false, 'a base commit that is not HEAD of the runner\'s git directory');

    const memoryOf = (label, files) => {
      const config = { layout: { memory: path.join(work, `memory-${label}`) } };
      fs.mkdirSync(config.layout.memory, { recursive: true });
      const dir = path.join(config.layout.memory, 'acme', 'app');
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
      return config;
    };
    const withMemory = async (label, change) => {
      const made = make(`memory-${label}`);
      const config = memoryOf(label, { 'NOTES.md': 'the notes of an earlier run\n', 'scripts/check.sh': '#!/bin/sh\n# checks\n' });
      const mem = openMemory(config, made.workspace, made.workspace.repo);
      if (change) change(mem);
      return unchanged(made, mem);
    };
    assert.equal(await withMemory('same', null), true, 'a memory copy as it was handed over');
    assert.equal(await withMemory('edit', (mem) => fs.appendFileSync(path.join(mem.copy, 'NOTES.md'), 'a new note\n')), false, 'an edited note');
    assert.equal(await withMemory('script', (mem) => fs.writeFileSync(path.join(mem.copy, 'scripts', 'new.sh'), '#!/bin/sh\n')), false, 'a new script');
    assert.equal(await withMemory('removed', (mem) => fs.rmSync(path.join(mem.copy, 'scripts', 'check.sh'))), false, 'a removed script');
    assert.equal(await withMemory('mode', (mem) => fs.chmodSync(path.join(mem.copy, 'scripts', 'check.sh'), 0o755)), false, 'a changed mode');
    assert.equal(await withMemory('link', (mem) => fs.symlinkSync('/etc/passwd', path.join(mem.copy, 'scripts', 'link.sh'))), false, 'a link');
    assert.equal(await withMemory('stray', (mem) => fs.writeFileSync(path.join(mem.copy, 'stray.txt'), 'x\n')), false, 'a file that is neither notes nor a script');
    assert.equal(await withMemory('gone', (mem) => fs.rmSync(mem.copy, { recursive: true, force: true })), false, 'a memory copy that is gone');
    assert.equal(await withMemory('replaced', (mem) => {
      fs.rmSync(mem.copy, { recursive: true, force: true });
      fs.symlinkSync('/etc', mem.copy);
    }), false, 'a memory copy replaced by a link');

    const scratch = path.join(work, 'scratch');
    fs.mkdirSync(path.join(scratch, '.opencode'), { recursive: true });
    fs.mkdirSync(path.join(scratch, '.sre-agent-memory'));
    const none = { dir: scratch, gitdir: null, repo: null, branch: null, defaultBranch: null, cleanUrl: null };
    assert.equal(await workspaceUnchanged(none, null, null), true, 'a scratch directory with only the runner\'s own entries');
    fs.writeFileSync(path.join(scratch, 'notes.txt'), 'x\n');
    assert.equal(await workspaceUnchanged(none, null, null), false, 'a scratch directory with a file the agent made');
  });

  if (failed > 0) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main();
