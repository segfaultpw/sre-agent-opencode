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
    const { workspaceUnchanged, setIdentity, openMemory, reclaim, stageAndGate } = runner.internals;
    setIdentity({ mode: 'none', runner: null, agent: null });
    const git = (cwd, ...args) => {
      const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
      assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
      return done.stdout.trim();
    };
    // A checkout the way the runner makes one: the git directory is a separate one the
    // agent never holds, the tree is only files, the base commit is what HEAD is.
    // A commit of another repository, which a gitlink of the base can point at.
    const submoduleCommit = (() => {
      const source = path.join(work, 'submodule-source');
      fs.mkdirSync(source, { recursive: true });
      git(source, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(source, 'f'), 'a\n');
      git(source, 'add', 'f');
      git(source, 'commit', '-q', '-m', 'inner');
      return git(source, 'rev-parse', 'HEAD');
    })();
    // `gitlink` puts a submodule at sub/ in the base commit; the runner never fills
    // it, so the directory is empty, as a checkout leaves it.
    const make = (label, { gitlink = false } = {}) => {
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
      if (gitlink) named('update-index', '--add', '--cacheinfo', `160000,${submoduleCommit},sub`);
      named('commit', '-q', '-m', 'base');
      const baseSha = named('rev-parse', 'HEAD');
      if (gitlink) fs.mkdirSync(path.join(dir, 'sub'));
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
      'a tracked configuration file written back where the runner marked it skip-worktree': (m) => {
        fs.writeFileSync(path.join(m.dir, 'opencode.json'), '{"permission": {"bash": {"*": "allow"}}}\n');
      },
    };
    for (const [label, change] of Object.entries(cases)) {
      const made = make(label.replace(/[^a-z]+/g, '-'));
      change(made);
      assert.equal(await unchanged(made), false, label);
    }

    // What the agent can leave for the runner's own git: a repository with a filter
    // driver and attributes that name it, in a path the base keeps for a submodule
    // or anywhere else below the root. A driver runs as whoever runs git, so its
    // marker file must never be written, whatever the runner does next.
    const plantRepository = (at, marker) => {
      fs.mkdirSync(at, { recursive: true });
      git(at, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(at, 'f'), 'a\n');
      git(at, 'add', 'f');
      git(at, 'commit', '-q', '-m', 'inner');
      fs.writeFileSync(path.join(at, 'f'), 'b\n');
      fs.appendFileSync(path.join(at, '.git', 'config'), `[filter "evil"]\n\tclean = touch ${marker}\n[core]\n\tfsmonitor = touch ${marker}.fsmonitor\n`);
      fs.writeFileSync(path.join(at, '.gitattributes'), '* filter=evil\n');
    };
    const ran = (marker) => [marker, `${marker}.fsmonitor`].filter((file) => fs.existsSync(file));

    const gitlinkClean = make('gitlink-clean', { gitlink: true });
    assert.equal(await unchanged(gitlinkClean), true, 'an empty submodule directory is the base');
    assert.deepEqual((await stageAndGate(gitlinkClean.workspace, new Set())).changed, [], 'and stages nothing');

    const inSubmodule = make('gitlink-plant', { gitlink: true });
    const markerSubmodule = path.join(work, 'marker-submodule');
    plantRepository(path.join(inSubmodule.dir, 'sub'), markerSubmodule);
    assert.equal(await unchanged(inSubmodule), false, 'a repository in a submodule path is a difference');
    assert.deepEqual(ran(markerSubmodule), [], 'the planted filter never ran for the proof');
    assert.deepEqual(fs.readdirSync(path.join(inSubmodule.dir, 'sub')), [], 'the submodule path is emptied');

    const nestedOutside = make('nested-plant');
    const markerNested = path.join(work, 'marker-nested');
    plantRepository(path.join(nestedOutside.dir, 'a', 'b'), markerNested);
    assert.equal(await unchanged(nestedOutside), false, 'a repository outside any submodule path is a difference');
    assert.deepEqual(ran(markerNested), []);
    assert.equal(fs.existsSync(path.join(nestedOutside.dir, 'a', 'b', '.git')), false, 'its .git is removed');
    assert.equal(fs.existsSync(path.join(nestedOutside.dir, 'a', 'b', 'f')), true, 'the files around it are the tree\'s and stay');

    // A submodule the agent initialised to build or test is no reason to refuse the
    // request: its path is emptied before git reads it, the change beside it is
    // staged, and the path is told as removed.
    const stagedPlant = make('gitlink-stage', { gitlink: true });
    const markerStaged = path.join(work, 'marker-staged');
    plantRepository(path.join(stagedPlant.dir, 'sub'), markerStaged);
    fs.appendFileSync(path.join(stagedPlant.dir, 'README.md'), 'a real change\n');
    const published = await stageAndGate(stagedPlant.workspace, new Set());
    assert.deepEqual(ran(markerStaged), [], 'the planted filter never ran for staging');
    assert.deepEqual(published.embedded, [], 'a repository in a submodule path is not refused');
    assert.deepEqual(published.flagged, []);
    assert.deepEqual(published.removed, ['sub/'], 'it is told as removed, by its path');
    assert.deepEqual(published.changed, ['README.md'], 'the change beside it is staged');
    assert.equal(stagedPlant.named('diff', '--cached', '--name-only'), 'README.md', 'and nothing of the submodule is');
    assert.equal(stagedPlant.named('diff', '--cached', '--raw', '--', 'sub'), '', 'the base pointer is as the base had it');
    assert.equal(stagedPlant.named('ls-files', '-t', 'sub'), 'H sub', 'and the mark that kept git out of the path is taken off again');
    assert.deepEqual(fs.readdirSync(path.join(stagedPlant.dir, 'sub')), [], 'the path is empty');

    // Under an ignored directory, by the ignore file or by a rule above it.
    const ignoredStage = make('ignored-stage');
    fs.appendFileSync(path.join(ignoredStage.workspace.gitdir, 'info', 'exclude'), 'vendor/\n');
    const markerIgnored = path.join(work, 'marker-ignored');
    plantRepository(path.join(ignoredStage.dir, 'cache', 'pkg'), markerIgnored);
    plantRepository(path.join(ignoredStage.dir, 'vendor', 'deep', 'pkg'), `${markerIgnored}-v`);
    fs.appendFileSync(path.join(ignoredStage.dir, 'README.md'), 'a real change\n');
    const ignoredResult = await stageAndGate(ignoredStage.workspace, new Set());
    assert.deepEqual([...ran(markerIgnored), ...ran(`${markerIgnored}-v`)], [], 'no filter ran');
    assert.deepEqual(ignoredResult.embedded, [], 'a repository under an ignored directory is not refused');
    assert.deepEqual(ignoredResult.removed, ['cache/pkg/', 'vendor/deep/pkg/']);
    assert.deepEqual(ignoredResult.changed, ['README.md'], 'and the change beside them is staged');
    assert.equal(fs.existsSync(path.join(ignoredStage.dir, 'vendor', 'deep', 'pkg', '.git')), false);

    const nestedStage = make('nested-stage');
    const markerNestedStage = path.join(work, 'marker-nested-stage');
    plantRepository(path.join(nestedStage.dir, 'deep', 'inner'), markerNestedStage);
    const refusedNested = await stageAndGate(nestedStage.workspace, new Set());
    assert.deepEqual(ran(markerNestedStage), []);
    assert.deepEqual(refusedNested.embedded, ['deep/inner/'], 'a repository in a path the pull request could hold is still refused');
    assert.deepEqual(refusedNested.removed, []);
    assert.equal(fs.existsSync(path.join(nestedStage.dir, 'deep', 'inner', '.git')), false);

    // What reclaim found is remembered: the checkout holds nothing of it afterwards,
    // and the proof and the gate still say it was there.
    const reclaimed = make('gitlink-reclaim', { gitlink: true });
    const markerReclaimed = path.join(work, 'marker-reclaimed');
    plantRepository(path.join(reclaimed.dir, 'sub'), markerReclaimed);
    plantRepository(path.join(reclaimed.dir, 'x', 'y'), `${markerReclaimed}-y`);
    assert.equal(await reclaim(reclaimed.dir, null, reclaimed.workspace), true);
    assert.deepEqual([...reclaimed.workspace.planted].sort(), ['sub/', 'x/y/']);
    assert.deepEqual(reclaimed.workspace.plants.submodule, ['sub/']);
    assert.deepEqual(reclaimed.workspace.plants.embedded, ['x/y/']);
    assert.deepEqual(fs.readdirSync(path.join(reclaimed.dir, 'sub')), []);
    assert.equal(fs.existsSync(path.join(reclaimed.dir, 'x', 'y', '.git')), false);
    assert.equal(await unchanged(reclaimed), false, 'the proof knows what reclaim removed');
    const refusedAfter = await stageAndGate(reclaimed.workspace, new Set());
    assert.deepEqual(refusedAfter.embedded, ['x/y/'], 'and the gate refuses the one the pull request could hold');
    assert.deepEqual(refusedAfter.removed, ['sub/'], 'and tells the other');
    assert.deepEqual([...ran(markerReclaimed), ...ran(`${markerReclaimed}-y`)], []);

    // A request after one that left a repository: the next request's own checkout
    // starts from what the runner made of it, so nothing is reported for it.
    const later = make('gitlink-later', { gitlink: true });
    assert.equal(await reclaim(later.dir, null, later.workspace), true);
    assert.equal(later.workspace.planted, undefined, 'a quiet run records nothing');
    assert.equal(await unchanged(later), true);

    // The removal never follows a link: a link in a submodule path, a link above
    // one, and a link to a directory that holds a repository all leave the target alone.
    const links = make('links', { gitlink: true });
    const outside = path.join(work, 'outside-target');
    fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'repo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(outside, 'sub', 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(outside, 'inner', 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(outside, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.rmSync(path.join(links.dir, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(links.dir, 'sub'));
    fs.symlinkSync(outside, path.join(links.dir, 'link-to-repo'));
    assert.equal(await unchanged(links), false, 'a link where the submodule was is a difference');
    assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true, 'the target of a link is untouched');
    assert.equal(fs.existsSync(path.join(outside, 'repo', '.git', 'HEAD')), true, 'a repository behind a link is not entered');
    const above = make('links-above');
    fs.writeFileSync(path.join(above.dir, 'src', '.keep'), '');
    // A gitlink whose parent directory was replaced by a link out of the tree.
    above.named('update-index', '--add', '--cacheinfo', `160000,${submoduleCommit},src/inner`);
    fs.rmSync(path.join(above.dir, 'src'), { recursive: true });
    fs.symlinkSync(outside, path.join(above.dir, 'src'));
    await unchanged(above);
    assert.equal(fs.existsSync(path.join(outside, 'inner', 'keep.txt')), true, 'the directory the gitlink names, behind the link above it, is not emptied');
    assert.equal(fs.existsSync(path.join(outside, 'sub', 'keep.txt')), true, 'nor is anything else outside the tree');

    // A directory the agent made unreadable is the runner's to open and remove.
    const closed = make('closed');
    plantRepository(path.join(closed.dir, 'locked', 'inner'), path.join(work, 'marker-closed'));
    fs.chmodSync(path.join(closed.dir, 'locked', 'inner', '.git'), 0o000);
    fs.chmodSync(path.join(closed.dir, 'locked'), 0o000);
    assert.equal(await unchanged(closed), false);
    assert.equal(fs.existsSync(path.join(closed.dir, 'locked', 'inner', '.git')), false);
    assert.deepEqual(ran(path.join(work, 'marker-closed')), []);

    // A directory the agent made unreadable holds a link to somewhere outside: the
    // runner opens what is its own and never chmods what the link points at.
    const guarded = path.join(work, 'outside-mode');
    fs.mkdirSync(guarded, { recursive: true });
    fs.chmodSync(guarded, 0o500);
    const linked = make('closed-link');
    plantRepository(path.join(linked.dir, 'locked', 'inner'), path.join(work, 'marker-closed-link'));
    fs.symlinkSync(guarded, path.join(linked.dir, 'locked', 'inner', '.git', 'link-out'));
    fs.chmodSync(path.join(linked.dir, 'locked', 'inner', '.git'), 0o000);
    assert.equal(await unchanged(linked), false);
    assert.equal(fs.existsSync(path.join(linked.dir, 'locked', 'inner', '.git')), false);
    assert.equal(fs.statSync(guarded).mode & 0o777, 0o500, 'the directory behind a link is not given another mode');

    // git reads `.git` whatever its case on a file system that folds it.
    const upper = make('upper-case');
    fs.mkdirSync(path.join(upper.dir, 'mixed', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(upper.dir, 'mixed', 'pkg', '.GIT'));
    fs.writeFileSync(path.join(upper.dir, 'mixed', 'pkg', '.GIT', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(await unchanged(upper), false);
    assert.equal(fs.existsSync(path.join(upper.dir, 'mixed', 'pkg', '.GIT')), false, 'a .GIT is removed too');

    // A path component swapped for a link while the runner is cleaning, as another
    // account that still holds a directory of the tree could: the removal must not
    // reach what the link points at. fs is patched at the one call where the swap
    // happens, the way that account's write would land between two of the runner's
    // calls; nothing of the runner is changed for it.
    const swapped = make('swapped');
    swapped.named('update-index', '--add', '--cacheinfo', `160000,${submoduleCommit},third/lib`);
    const victim = path.join(work, 'swap-victim');
    fs.rmSync(victim, { recursive: true, force: true });
    fs.mkdirSync(path.join(victim, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'lib', 'precious.txt'), 'keep me\n');
    fs.mkdirSync(path.join(victim, 'other', '.git'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'other', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(swapped.dir, 'third', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(swapped.dir, 'third', 'lib', 'planted'), 'x\n');
    fs.mkdirSync(path.join(swapped.dir, 'w', 'd'), { recursive: true });
    const realListing = fs.promises.readdir;
    const realListingSync = fs.readdirSync;
    let swappedGitlink = false;
    let swappedWalk = false;
    // One swap for each listing the runner makes, whichever way it makes it.
    const swapBefore = (target) => {
      if (!swappedGitlink && String(target) === path.join(swapped.dir, 'third', 'lib')) {
        swappedGitlink = true;
        fs.renameSync(path.join(swapped.dir, 'third'), path.join(work, 'swap-third-moved'));
        fs.symlinkSync(victim, path.join(swapped.dir, 'third'));
      }
    };
    const swapAfter = (target) => {
      if (!swappedWalk && String(target) === path.join(swapped.dir, 'w')) {
        swappedWalk = true;
        fs.rmSync(path.join(swapped.dir, 'w', 'd'), { recursive: true });
        fs.symlinkSync(victim, path.join(swapped.dir, 'w', 'd'));
      }
    };
    fs.promises.readdir = async function patched(target, options) {
      swapBefore(target);
      const listed = await realListing.call(fs.promises, target, options);
      swapAfter(target);
      return listed;
    };
    fs.readdirSync = function patchedSync(target, options) {
      swapBefore(target);
      const listed = realListingSync.call(fs, target, options);
      swapAfter(target);
      return listed;
    };
    try {
      assert.equal(await reclaim(swapped.dir, null, swapped.workspace), true);
    } finally {
      fs.promises.readdir = realListing;
      fs.readdirSync = realListingSync;
    }
    assert.ok(swappedGitlink && swappedWalk, 'both swaps happened');
    assert.equal(fs.existsSync(path.join(victim, 'lib', 'precious.txt')), true, 'a link swapped in above a gitlink path is not followed by the removal');
    assert.equal(fs.existsSync(path.join(victim, 'other', '.git', 'HEAD')), true, 'a link swapped in for a directory the walk was about to enter is not entered');
    assert.deepEqual(swapped.workspace.plants && swapped.workspace.plants.escaped, ['third/lib/', 'w/d/'], 'both are told as what they are, and refuse the request');

    // A repository put back in a submodule path after the scrub and before the
    // runner stages (the window another account that holds a directory of the
    // tree would have): git is not let look under the base's gitlink paths at all.
    const lateDir = path.join(work, 'late-wrapper');
    fs.mkdirSync(lateDir, { recursive: true });
    const lateTemplate = path.join(work, 'late-template');
    const markerLate = path.join(work, 'marker-late');
    plantRepository(lateTemplate, markerLate);
    const lateGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const lateMade = make('late-replant', { gitlink: true });
    const lateTarget = path.join(lateMade.dir, 'sub');
    fs.writeFileSync(
      path.join(lateDir, 'git'),
      `#!/usr/bin/env bash\nfor argument in "$@"; do\n  if [ "$argument" = add ] && [ ! -e "${lateTarget}/.git" ]; then\n    mkdir -p "${lateTarget}" && cp -a "${lateTemplate}/." "${lateTarget}/"\n  fi\ndone\nexec "${lateGit}" "$@"\n`,
      { mode: 0o755 }
    );
    fs.appendFileSync(path.join(lateMade.dir, 'README.md'), 'a real change\n');
    const savedPath = process.env.PATH;
    process.env.PATH = `${lateDir}:${savedPath}`;
    let lateResult;
    try {
      lateResult = await stageAndGate(lateMade.workspace, new Set());
    } finally {
      process.env.PATH = savedPath;
    }
    assert.ok(fs.existsSync(path.join(lateMade.dir, 'sub', '.git')), 'the repository was put back while the runner staged');
    assert.deepEqual(ran(markerLate), [], 'and its filter did not run');
    assert.deepEqual(lateResult.changed, ['README.md'], 'the change is staged, and the submodule is not touched');
    assert.equal(lateMade.named('ls-files', '-t', 'sub'), 'H sub', 'the mark is off again');

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

  // What the runner does to a tree another account has had. The agent account is
  // never this test's own, so the split is stood in for: identity mode `caps`
  // with the runner's own ids, which is what closeTree gives a tree to.
  const asSplit = (extra = {}) => {
    const me = { uid: process.getuid(), gid: process.getgid() };
    runner.internals.setIdentity({ mode: 'caps', runner: { ...me, home: work }, agent: { uid: me.uid + 1, gid: me.gid + 1, home: work }, ...extra });
  };
  const noSplit = () => runner.internals.setIdentity({ mode: 'none', runner: null, agent: null });
  const modeOf = (target) => fs.lstatSync(target).mode & 0o7777;
  // A tree these checks left with directories nobody can enter is still removed.
  const scrub = (target) => {
    spawnSync('chmod', ['-R', 'u+rwx', target]);
    spawnSync('rm', ['-rf', target]);
  };
  const walk = (dir, visit) => {
    visit(dir);
    if (fs.lstatSync(dir).isDirectory()) for (const name of fs.readdirSync(dir)) walk(path.join(dir, name), visit);
  };

  await check('closeTree: one pass fixes each directory before it lists it, and leaves no directory open and no link followed', async () => {
    const { closeTree } = runner.internals;
    const root = path.join(work, 'close-pass');
    scrub(root);
    fs.mkdirSync(path.join(root, 'open', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(root, 'locked', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sticky'));
    fs.writeFileSync(path.join(root, 'open', 'inner', 'file'), 'x\n', { mode: 0o666 });
    fs.writeFileSync(path.join(root, 'open', 'script'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'open', 'setuid'), 'x\n');
    fs.chmodSync(path.join(root, 'open', 'setuid'), 0o4777);
    fs.writeFileSync(path.join(root, 'locked', 'inner', 'file'), 'x\n', { mode: 0o000 });
    spawnSync('mkfifo', [path.join(root, 'open', 'fifo')]);
    fs.chmodSync(path.join(root, 'open', 'fifo'), 0o666);
    const outside = path.join(work, 'close-outside');
    scrub(outside);
    fs.mkdirSync(outside, { mode: 0o777 });
    fs.chmodSync(outside, 0o777);
    fs.writeFileSync(path.join(outside, 'precious'), 'x\n');
    fs.chmodSync(path.join(outside, 'precious'), 0o666);
    fs.symlinkSync(outside, path.join(root, 'open', 'link'));
    fs.chmodSync(path.join(root, 'open', 'inner'), 0o777);
    fs.chmodSync(path.join(root, 'open'), 0o777);
    fs.chmodSync(path.join(root, 'sticky'), 0o1777);
    fs.chmodSync(path.join(root, 'locked', 'inner'), 0o000);
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    fs.chmodSync(root, 0o777);
    asSplit();
    try {
    // What a directory looks like at the moment its listing is read: closed already.
    const realList = fs.readdirSync;
    const atListing = [];
    fs.readdirSync = function patched(target, ...rest) {
      if (String(target).startsWith('/proc/self/fd/')) atListing.push(fs.statSync(target).mode & 0o7777);
      return realList.call(fs, target, ...rest);
    };
    try {
      await closeTree(root);
    } finally {
      fs.readdirSync = realList;
      noSplit();
    }
    assert.ok(atListing.length >= 6, `every directory was listed through its descriptor (${atListing.length})`);
    assert.deepEqual([...new Set(atListing)], [0o700], 'each directory was mode 0700 and the runner\'s when its listing was read');
    const seen = [];
    walk(root, (entry) => seen.push(entry));
    for (const entry of seen) {
      const stat = fs.lstatSync(entry);
      assert.equal(stat.uid, process.getuid(), entry);
      if (stat.isDirectory()) assert.equal(stat.mode & 0o7777, 0o700, `${entry} is a closed directory`);
      else if (!stat.isSymbolicLink()) assert.equal(stat.mode & 0o7077, 0, `${entry} has no group or other bit, no setuid`);
    }
    assert.equal(modeOf(path.join(root, 'open', 'script')) & 0o100, 0o100, 'an executable file stays executable for its owner');
    assert.equal(modeOf(path.join(root, 'open', 'inner', 'file')) & 0o600, 0o600, 'and a file the owner could not read can be read');
    assert.equal(modeOf(outside), 0o777, 'the directory a link names is not changed');
    assert.equal(modeOf(path.join(outside, 'precious')), 0o666, 'nor is a file in it');
    } finally {
      scrub(root);
      scrub(outside);
    }
  });

  await check('closeTree: a tree nested deeper than a path can be named is closed, and removed, without a descriptor for every level', async () => {
    const { closeTree, removeTree } = runner.internals;
    const root = path.join(work, 'close-deep');
    scrub(root);
    fs.mkdirSync(root);
    const built = spawnSync('bash', ['-c', 'cd "$1" && for _ in $(seq 1 2300); do mkdir d && chmod 777 d && cd d || exit 1; done; touch file', 'x', root], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    asSplit();
    try {
      await closeTree(root);
      const found = spawnSync('find', [root, '(', '!', '-uid', String(process.getuid()), '-o', '(', '!', '-type', 'l', '-a', '-perm', '/077', ')', ')', '-print', '-quit'], { encoding: 'utf8' });
      assert.equal(found.stdout, '', 'nothing is left open');
      await removeTree(root);
      assert.equal(fs.existsSync(root), false, 'and the whole of it is removed');
    } finally {
      noSplit();
      scrub(root);
    }
  });

  await check('closeTree fails closed: a tree it cannot own is refused, and nothing is removed from it', async () => {
    if (process.getuid() === 0) return;
    const { closeTree, removeTree, removeEntries } = runner.internals;
    const root = path.join(work, 'close-refused');
    scrub(root);
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'keep'), 'x\n');
    // A runner account that is not this process's own: fchown to it is refused.
    asSplit({ runner: { uid: process.getuid() + 1, gid: process.getgid(), home: work } });
    try {
      await assert.rejects(closeTree(root), /could not be closed to other accounts/);
      await assert.rejects(removeTree(root), /could not be closed to other accounts/);
      await assert.rejects(removeEntries(root, ['a']), /is not closed/);
    } finally {
      noSplit();
    }
    assert.equal(fs.readFileSync(path.join(root, 'a', 'keep'), 'utf8'), 'x\n', 'nothing was removed');
    scrub(root);
  });

  await check('removeEntries refuses a tree that was not closed, and removes from one that was', async () => {
    const { closeTree, removeEntries } = runner.internals;
    const root = path.join(work, 'close-guard');
    scrub(root);
    fs.mkdirSync(path.join(root, 'x', 'y'), { recursive: true });
    fs.writeFileSync(path.join(root, 'x', 'y', 'f'), 'x\n');
    asSplit();
    try {
      await assert.rejects(removeEntries(root, ['x']), /is not closed/);
      assert.equal(fs.existsSync(path.join(root, 'x', 'y', 'f')), true);
      await closeTree(root);
      await removeEntries(root, ['x']);
      assert.equal(fs.existsSync(path.join(root, 'x')), false);
      await assert.rejects(removeEntries(root, ['../x']), /one name/);
      await assert.rejects(removeEntries(root, ['a/b']), /one name/);
    } finally {
      noSplit();
      scrub(root);
    }
  });

  await check('the instance directory is the runner\'s, mode 0710, with the group of that worker\'s agent alone', async () => {
    const { settleInstanceGate } = runner.internals;
    const dir = path.join(work, 'instances', 'pool-1');
    fs.rmSync(path.join(work, 'instances'), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const groups = [...new Set([process.getgid(), ...process.getgroups()])];
    const group = groups[groups.length - 1];
    asSplit({ agent: { uid: process.getuid() + 1, gid: group, home: work } });
    try {
      settleInstanceGate(dir);
      const stat = fs.statSync(dir);
      assert.equal(stat.mode & 0o7777, 0o710);
      assert.equal(stat.gid, group);
      assert.equal(stat.uid, process.getuid());
      fs.chmodSync(dir, 0o777);
      settleInstanceGate(dir);
      assert.equal(fs.statSync(dir).mode & 0o7777, 0o710, 'opened again, closed again at the next check');
      const target = path.join(work, 'instances', 'gate-target');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(work, 'instances', 'gate-link'));
      assert.throws(() => settleInstanceGate(path.join(work, 'instances', 'gate-link')), /ELOOP|link|directory/, 'a link is never followed');
      assert.notEqual(fs.statSync(target).mode & 0o7777, 0o710);
    } finally {
      noSplit();
    }
  });

  await check('a swap that happens while a tree is being removed never reaches what the link names, on the node the image ships and on this one', async () => {
    const race = path.resolve(__dirname, 'removal_race_test.js');
    const done = spawnSync(process.execPath, [race], { encoding: 'utf8', timeout: 240_000 });
    assert.equal(done.status, 0, `${done.stdout}${done.stderr}`);
    assert.match(done.stdout, /ok .*removeTree/);
  });

  await check('the paths a report names are redacted, one line each and bounded', async () => {
    const { shownPaths, redact } = runner.internals;
    const hold = load({ SRE_GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` }).runner;
    const secret = `ghp_${'a'.repeat(36)}`;
    const shown = hold.internals.shownPaths([`vendor/${secret}/`, `a\nb/`, `${'x'.repeat(400)}/`, ...Array.from({ length: 30 }, (_, n) => `d${n}/`)]);
    assert.equal(shown.some((entry) => entry.includes(secret)), false, 'a held secret in a name is masked');
    assert.equal(shown.every((entry) => !/[\n\r]/.test(entry)), true, 'one line each');
    assert.ok(shown[2].length <= 200, 'bounded');
    assert.equal(shown.length, 21, 'at most twenty, and one entry for the rest');
    assert.match(shown[20], /and 13 more/);
    assert.ok(typeof shownPaths === 'function' && typeof redact === 'function');
  });

  await check('a path found outside the checkout is told as that, not as an embedded repository', async () => {
    const { escapedReport } = runner.internals;
    const result = { summary: 'done', actions: [], evidence: {} };
    escapedReport(result, ['third/lib/', 'w/d/']);
    assert.deepEqual(result.evidence.escaped_paths, ['third/lib/', 'w/d/']);
    assert.match(result.summary, /resolved to a place outside the checkout while the runner was cleaning it/);
    assert.doesNotMatch(result.summary, /embedded|protected paths gate/);
    assert.ok(result.actions.some((line) => /outside the checkout/.test(line)));
  });

  await check('a skip-worktree mark that cannot be made or taken off leaves the index as it was, or the checkout marked to be cloned again', async () => {
    const { stageAndGate, setIdentity } = runner.internals;
    setIdentity({ mode: 'none', runner: null, agent: null });
    const git = (cwd, ...args) => {
      const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
      assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
      return done.stdout.trim();
    };
    const source = path.join(work, 'mark-source');
    fs.mkdirSync(source, { recursive: true });
    git(source, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(source, 'f'), 'a\n');
    git(source, 'add', 'f');
    git(source, 'commit', '-q', '-m', 'inner');
    const commit = git(source, 'rev-parse', 'HEAD');
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const build = (label) => {
      const root = path.join(work, `mark-${label}`);
      const dir = path.join(root, 'tree');
      const gitdir = path.join(root, 'gitdir');
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main', `--separate-git-dir=${gitdir}`);
      fs.rmSync(path.join(dir, '.git'), { force: true });
      fs.writeFileSync(path.join(dir, 'README.md'), 'the repository\n');
      const named = (...args) => git(dir, `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args);
      named('add', '-A');
      for (let n = 0; n < 205; n += 1) named('update-index', '--add', '--cacheinfo', `160000,${commit},sub${n}`);
      named('commit', '-q', '-m', 'base');
      const baseSha = named('rev-parse', 'HEAD');
      for (let n = 0; n < 205; n += 1) fs.mkdirSync(path.join(dir, `sub${n}`));
      fs.appendFileSync(path.join(dir, 'README.md'), 'a real change\n');
      return { workspace: { dir, gitdir, cleanUrl: 'https://github.com/acme/app.git', baseSha, repo: { owner: 'acme', name: 'app', fullName: 'acme/app' } }, named };
    };
    // git wrapper that fails the n-th `update-index` call
    const failing = (label, which) => {
      const wrapper = path.join(work, `mark-wrapper-${label}`);
      fs.mkdirSync(wrapper, { recursive: true });
      const counter = path.join(wrapper, 'count');
      fs.writeFileSync(counter, '0');
      fs.writeFileSync(
        path.join(wrapper, 'git'),
        `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = update-index ]; then n=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"; if ${which}; then echo "update-index refused" >&2; exit 1; fi; fi; done\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      return wrapper;
    };
    const withPath = async (wrapper, body) => {
      const saved = process.env.PATH;
      process.env.PATH = `${wrapper}:${saved}`;
      try {
        return await body();
      } finally {
        process.env.PATH = saved;
      }
    };
    const marked = (made) => made.named('ls-files', '-t').split('\n').filter((line) => /^S /.test(line)).length;
    // The second chunk of marks fails: the first chunk's marks may not stay in the index.
    const second = build('second');
    const wrapperSecond = failing('second', '[ "$n" = 2 ]');
    await assert.rejects(withPath(wrapperSecond, () => stageAndGate(second.workspace, new Set())), /update-index refused/);
    assert.equal(marked(second), 0, 'no gitlink is left skip-worktree after a mark that failed half way');
    // The mark can be made but not taken off: the original index comes back.
    const undo = build('undo');
    const wrapperUndo = failing('undo', '[ "$n" -gt 2 ]');
    await assert.rejects(withPath(wrapperUndo, () => stageAndGate(undo.workspace, new Set())), /update-index refused/);
    assert.equal(marked(undo), 0, 'no gitlink is left skip-worktree after an undo that failed');
    assert.equal(fs.existsSync(path.join(undo.workspace.gitdir, 'index.sre-agent-before-mark')), false, 'and the copy of the index is not left behind');
  });

  if (failed > 0) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main();
