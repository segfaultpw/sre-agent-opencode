#!/usr/bin/env node
'use strict';

// The runner answers SRE Agent fix requests on a machine the customer owns.
//
// It is the only thing on that machine that touches git or the network, which
// is the reason the sre-fix agent keeps the git push, curl, wget and webfetch
// denies it has in CI: the agent never needs any of them, so relaxing a fence
// would buy nothing. The order below is the contract, and each step's comment
// says why it sits where it does.
//
// Standard library only, on purpose: this is installed on somebody else's
// machine, so a dependency here is a supply chain they did not ask for.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

// The platform holds an empty queue open for up to 25 seconds. The request
// bound is longer than that so a held-open poll is never mistaken for a hung
// one, and shorter than a proxy's usual idle timeout so a dead connection is
// noticed rather than waited on.
const POLL_REQUEST_TIMEOUT_MS = 40_000;
const POLL_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const REPORT_ATTEMPTS = 3;
const HTTP_TIMEOUT_MS = 30_000;

// A git or gh call that hangs would wedge the runner for ever, so every child
// has a bound. Only the agent's is the operator's to set.
const PROCESS_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

// The same shapes the CI door uses, so a pull request from either door carries
// the same two lines: scripts/decline_comment.sh and fix.yml's marking step
// read the marker with this expression and append each line only when the body
// does not already carry it.
const MARKER_PATTERN = /<!-- sre-agent:remediation:[^>]*-->/;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Every secret the process holds, so no code path has to remember to redact.
// The runner logs into the customer's log aggregator, which has a different
// audience from ours, and a handoff token there is a live credential for the
// 24 hours it is valid.
const constantSecrets = [];
let jobSecret = null;

function redact(text) {
  let out = String(text);
  for (const secret of constantSecrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  if (jobSecret) out = out.split(jobSecret).join('[redacted]');
  return out;
}

let logLevel = LEVELS.info;

function log(level, message, fields) {
  if (LEVELS[level] < logLevel) return;
  const suffix = fields ? ` ${JSON.stringify(fields)}` : '';
  const line = `${new Date().toISOString()} ${level} ${message}${suffix}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${redact(line)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function readPackageFile(relative) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
}

function loadConfig() {
  const missing = ['SRE_SERVER_URL', 'SRE_API_KEY', 'SRE_MODEL'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw fatal(`the runner needs ${missing.join(', ')} in its environment and will not start without it`);
  }

  const timeoutSeconds = Number.parseInt(process.env.SRE_RUN_TIMEOUT_SECONDS || '1800', 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw fatal('SRE_RUN_TIMEOUT_SECONDS must be a positive whole number of seconds');
  }

  return {
    serverUrl: process.env.SRE_SERVER_URL.replace(/\/+$/, ''),
    apiKey: process.env.SRE_API_KEY,
    model: process.env.SRE_MODEL,
    workspace: process.env.SRE_WORKSPACE || '/workspace',
    githubToken: process.env.SRE_GITHUB_TOKEN || '',
    runTimeoutMs: timeoutSeconds * 1000,
    runTimeoutSeconds: timeoutSeconds,
    version: readPackageFile('VERSION').trim(),
    once: process.env.SRE_ONCE === '1',
  };
}

function httpRequest(target, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = HTTP_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch {
      reject(new Error('the platform sent a malformed URL'));
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`the platform sent a ${url.protocol} URL, which the runner does not follow`));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`the request took longer than ${timeoutMs} ms`));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, which is the outcome the kill was after.
    }
  }
}

function runProcess(command, args, options = {}) {
  const { cwd, env, input = null, timeoutMs = PROCESS_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    // Its own process group: opencode starts a local server of its own, and a
    // timeout that killed only the parent would leave that child holding the
    // pipes open and the runner waiting on a run it already gave up on.
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error.message, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    let graceTimer = null;

    const done = (result) => {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      resolve(result);
    };

    // Decoded by the stream rather than by concatenation, so a multi-byte
    // character split across two chunks does not come back mangled.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      done({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code, signal) => {
      done({ code, signal, stdout, stderr, timedOut });
    });

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        graceTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.stdin.on('error', () => {
      // A child that exits before reading its input closes the pipe; the exit
      // status is the answer that matters, not the write that lost the race.
    });
    child.stdin.end(input === null ? '' : input);
  });
}

function gitEnv() {
  // GIT_TERMINAL_PROMPT=0 turns a missing credential into a failure instead of
  // a service that hangs on a password prompt nobody will ever answer.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-C' || args[index] === '-c') {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('-')) return args[index];
  }
  return 'command';
}

async function git(args) {
  const result = await runProcess('git', args, { env: gitEnv() });
  if (result.code !== 0) {
    throw new Error(`git ${gitSubcommand(args)} failed: ${redact(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

// Step 1. Poll. One request, held open by the platform. A 401 is fatal because
// retrying a key the platform has already refused produces nothing but a
// warning every 25 seconds in somebody's logs, which is the shape that reached
// production once already.
async function poll(config) {
  const url = `${config.serverUrl}/api/fix-runner/queue`;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    let response = null;
    let failure = '';
    try {
      response = await httpRequest(url, {
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      failure = error.message;
    }

    if (response && (response.status === 401 || response.status === 403)) {
      throw fatal(
        `the queue refused SRE_API_KEY with HTTP ${response.status}; check the value of SRE_API_KEY and that it carries the fix_runner:poll scope`
      );
    }

    if (response && response.status >= 200 && response.status < 300) {
      try {
        const payload = JSON.parse(response.body);
        if (!Array.isArray(payload.data)) throw new Error('the queue answered without a data array');
        return payload.data;
      } catch (error) {
        failure = error.message;
      }
    } else if (response) {
      failure = `HTTP ${response.status}`;
    }

    if (attempt === POLL_ATTEMPTS) {
      throw new Error(`the queue did not answer after ${POLL_ATTEMPTS} attempts: ${failure}`);
    }
    const delay = backoffMs(attempt);
    log('warn', `the queue could not be read (${failure}); retrying in ${delay} ms`);
    await sleep(delay);
  }
  return [];
}

// Step 2. Fetch the brief with the handoff token, never with the API key: the
// key reaches the queue and nothing else, and the token reaches one handoff.
// This call is also what tells the platform the job was collected, so it runs
// before any expensive local work.
async function fetchBrief(job) {
  const response = await httpRequest(job.brief_url, {
    headers: { Authorization: `Bearer ${job.token}`, Accept: 'text/markdown' },
  });
  if (response.status !== 200) {
    throw new Error(`the brief could not be fetched (HTTP ${response.status})`);
  }
  return response.body;
}

function parseRepo(fullName) {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(fullName);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error(`the request named the repository ${fullName}, which is not an owner/name pair`);
  }
  return { owner: match[1], name: match[2], fullName };
}

// Step 3. Prepare the workspace. The credential is passed on the command line
// for the calls that need it and origin keeps the clean URL, so a token is
// never written into .git/config where a later run, or the operator, would
// find it.
async function prepareCheckout(config, job, repo) {
  if (!config.githubToken) {
    throw new Error('this request names a repository and the runner has no SRE_GITHUB_TOKEN to reach it with');
  }
  const cleanUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  const authUrl = `https://x-access-token:${config.githubToken}@github.com/${repo.owner}/${repo.name}.git`;
  const dir = path.join(config.workspace, repo.owner, repo.name);

  const symref = await runProcess('git', ['ls-remote', '--symref', authUrl, 'HEAD'], { env: gitEnv() });
  if (symref.code !== 0) {
    throw new Error(`${repo.fullName} could not be reached: ${redact(symref.stderr).trim()}`);
  }
  const defaultBranch = (/^ref:\s+refs\/heads\/(\S+)/m.exec(symref.stdout) || [])[1];
  if (!defaultBranch) {
    throw new Error(`${repo.fullName} did not name a default branch`);
  }

  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['clone', authUrl, dir]);
    await git(['-C', dir, 'remote', 'set-url', 'origin', cleanUrl]);
  } else {
    await git(['-C', dir, 'fetch', '--prune', authUrl, '+refs/heads/*:refs/remotes/origin/*']);
  }

  const branch = `sre-agent/${job.handoff_id}`;
  // -f discards whatever a previous run left behind, so one abandoned run
  // cannot put its changes into the next request's pull request.
  await git(['-C', dir, 'checkout', '-f', '-B', branch, `refs/remotes/origin/${defaultBranch}`]);
  await git(['-C', dir, 'clean', '-fd']);

  // opencode reads configuration and plugins out of the repository it runs in
  // and merges ours over that rather than replacing it, so a checkout can
  // reorder our fences into uselessness, and a file under .opencode/plugin
  // runs before any gate is consulted. The checkout loses those paths before
  // the agent starts. This runs after the clean, or the clean would restore
  // them.
  const stripped = await runProcess('bash', [path.join(PACKAGE_ROOT, 'scripts', 'strip_repo_config.sh'), dir], {
    env: gitEnv(),
  });
  if (stripped.code !== 0) {
    throw new Error(`the checkout could not be stripped of its own opencode configuration: ${redact(stripped.stderr).trim()}`);
  }
  for (const line of stripped.stdout.split('\n')) {
    if (line.trim().startsWith('removed ')) log('warn', `${repo.fullName}: ${line.trim()}`);
  }

  const tracked = await runProcess('git', ['-C', dir, 'ls-files', '--error-unmatch', '.opencode/agents/sre-fix.md'], {
    env: gitEnv(),
  });
  if (tracked.code === 0) {
    throw new Error(
      `${repo.fullName} tracks .opencode/agents/sre-fix.md; the package writes its own agent there, so remove or rename that file`
    );
  }

  // The action stages the whole tree in CI and this runner stages the whole
  // tree too, so the agent file has to be invisible to git or it would land in
  // every pull request.
  const excludePath = path.join(dir, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const exclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (!exclude.split('\n').includes('.opencode/')) {
    fs.appendFileSync(excludePath, `${exclude.endsWith('\n') || exclude === '' ? '' : '\n'}.opencode/\n`);
  }

  return { dir, repo, branch, defaultBranch, authUrl };
}

function prepareScratch(config) {
  // One fixed directory rather than one per handoff: an untargeted answer has
  // nothing to publish, so the only reason to keep it is for the operator to
  // read the last one, and a directory per request would grow without bound.
  const dir = path.join(config.workspace, 'scratch');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { dir, repo: null, branch: null, defaultBranch: null, authUrl: null };
}

function writeAgent(config, dir) {
  const agentDir = path.join(dir, '.opencode', 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  const agent = readPackageFile('agents/sre-fix.md').split('{{SRE_AGENT_OPENCODE_VERSION}}').join(`v${config.version}`);
  fs.writeFileSync(path.join(agentDir, 'sre-fix.md'), agent);
}

function agentConfigContent() {
  const parsed = JSON.parse(readPackageFile('config/opencode.json'));
  parsed.default_agent = 'sre-fix';
  return JSON.stringify(parsed);
}

// Step 4. Run the agent, one shot, with the brief on stdin and the package's
// fences handed over the way fix.yml hands them over. The runner's own
// credentials are stripped from the child's environment: the agent has a
// shell, so anything left there is reachable, and it needs none of them.
async function runAgent(config, workspace, brief) {
  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: agentConfigContent(),
    // A binary that updated itself mid-run would be a different matcher
    // enforcing the fences than the one the release was tested against.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  delete env.SRE_API_KEY;
  delete env.SRE_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  // No --auto: the configuration leaves no permission at ask, and an
  // unexpected one is rejected rather than approved.
  const args = ['run', '--agent', 'sre-fix', '--model', config.model, '--format', 'json'];
  const result = await runProcess('opencode', args, {
    cwd: workspace,
    env,
    input: brief,
    timeoutMs: config.runTimeoutMs,
  });

  const texts = [];
  const errors = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'text' && event.part && typeof event.part.text === 'string') {
      const text = event.part.text.trim();
      if (text) texts.push(text);
    }
    if (event.type === 'error') {
      const detail = (event.error && ((event.error.data && event.error.data.message) || event.error.name)) || 'unknown';
      errors.push(String(detail));
    }
  }

  return {
    code: result.code,
    timedOut: result.timedOut,
    finalMessage: texts.length > 0 ? texts[texts.length - 1] : '',
    errors,
    stderr: result.stderr,
  };
}

// Step 5. The gate. The fences are opencode's own tool gates and the agent
// also runs a shell, which can write a file without any tool, so what actually
// changed is judged here, by the same script the CI door uses, before anything
// is published.
async function stageAndGate(dir) {
  await git(['-C', dir, 'add', '-A']);
  const staged = (await git(['-C', dir, 'diff', '--cached', '--name-only']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (staged.length === 0) return { changed: [], flagged: [] };

  const gate = await runProcess('bash', [path.join(PACKAGE_ROOT, 'scripts', 'protected_paths.sh')], {
    input: `${staged.join('\n')}\n`,
  });
  const flagged = gate.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (gate.code !== 0 && flagged.length === 0) {
    throw new Error(`the protected paths gate failed to run: ${gate.stderr.trim()}`);
  }
  return { changed: staged, flagged };
}

function pullRequestTitle(message, handoffId) {
  const line = message
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !candidate.startsWith('<!--'));
  if (!line) return `SRE Agent fix ${handoffId}`;
  const cleaned = line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned;
}

function pullRequestBody(message, brief, version) {
  const marker = (MARKER_PATTERN.exec(brief) || [])[0] || '';
  const stamp = `<!-- sre-agent-opencode:v${version} -->`;
  let tail = '';
  if (marker && !message.includes(marker)) tail += `${marker}\n`;
  if (!message.includes(stamp)) tail += `${stamp}\n`;
  return tail ? `${message}\n\n${tail}` : `${message}\n`;
}

// Step 6. Publish, and only now: the tree changed, the gate passed, and the
// agent did not decline.
async function publish(config, workspace, message, brief, result) {
  const { dir, repo, branch, defaultBranch, authUrl } = workspace;
  const title = pullRequestTitle(message, path.basename(branch));

  // The identity is set on the command rather than in the repository, because
  // a service account has no git identity of its own and "empty ident name"
  // after the agent has already done its work is a failure the CI door hit
  // once for exactly this reason.
  await git([
    '-C',
    dir,
    '-c',
    'user.name=sre-agent-fix-runner',
    '-c',
    'user.email=sre-agent-fix-runner@users.noreply.github.com',
    'commit',
    '-m',
    title,
  ]);
  await git(['-C', dir, 'push', authUrl, `HEAD:refs/heads/${branch}`]);
  result.actions.push(`pushed ${branch} to ${repo.fullName}`);

  const bodyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sre-agent-pr-')), 'body.md');
  fs.writeFileSync(bodyPath, pullRequestBody(message, brief, config.version));

  const ghEnv = { ...process.env, GH_TOKEN: config.githubToken, GH_PROMPT_DISABLED: '1' };
  const base = [
    'pr',
    'create',
    '--repo',
    repo.fullName,
    '--base',
    defaultBranch,
    '--head',
    branch,
    '--title',
    title,
    '--body-file',
    bodyPath,
  ];

  let created = await runProcess('gh', [...base, '--draft'], { cwd: dir, env: ghEnv });
  if (created.code !== 0) {
    // Draft pull requests need a plan that supports them. The branch is
    // already pushed by this point, so refusing to open the pull request at
    // all would leave the work stranded where nobody looks for it.
    log('warn', 'the draft pull request was refused; opening it as a normal pull request instead');
    created = await runProcess('gh', base, { cwd: dir, env: ghEnv });
  }
  fs.rmSync(path.dirname(bodyPath), { recursive: true, force: true });

  if (created.code !== 0) {
    throw new Error(`the pull request could not be opened: ${redact(created.stderr).trim()}`);
  }

  const url = created.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http'))
    .pop();
  if (!url) {
    throw new Error('gh opened the pull request but printed no URL for it');
  }
  return url;
}

// Step 7. Report. This is the only thing that ends the request, so it runs in
// a finally: a crash between the run and the report leaves the platform
// waiting 45 minutes for its sweep to fail the row.
async function report(job, result) {
  const body = JSON.stringify({
    outcome: result.outcome,
    summary: result.summary,
    actions: result.actions,
    evidence: result.evidence,
    ...(result.pr_url ? { pr_url: result.pr_url } : {}),
  });

  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
    let response = null;
    let failure = '';
    try {
      response = await httpRequest(job.report_url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${job.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
    } catch (error) {
      failure = error.message;
    }

    if (response && response.status >= 200 && response.status < 300) {
      log('info', `reported ${result.outcome} for handoff ${job.handoff_id}`);
      return;
    }
    if (response && response.status === 409) {
      log('warn', `a different result already stands for handoff ${job.handoff_id}; this one was not recorded`);
      return;
    }
    if (response && response.status >= 400 && response.status < 500) {
      log('error', `the report for handoff ${job.handoff_id} was refused with HTTP ${response.status}`);
      return;
    }

    failure = failure || (response ? `HTTP ${response.status}` : 'no response');
    if (attempt === REPORT_ATTEMPTS) {
      log(
        'error',
        `the report for handoff ${job.handoff_id} could not be delivered (${failure}); the platform will fail this request when it sweeps`
      );
      return;
    }
    const delay = backoffMs(attempt);
    log('warn', `the report could not be delivered (${failure}); retrying in ${delay} ms`);
    await sleep(delay);
  }
}

function isDecline(message) {
  return /^declined:/i.test(message.trim());
}

async function handleJob(config, job) {
  if (!job || !job.handoff_id || !job.report_url || !job.token) {
    log('error', 'the queue answered with a job carrying no handoff id, report URL or credential; skipping it');
    return;
  }

  jobSecret = job.token;
  log('info', 'collected a fix request', {
    handoff_id: job.handoff_id,
    subject_id: job.subject_id || null,
    repo_full_name: job.repo_full_name || null,
  });

  // not_validated is the only outcome this runner ever sends. The platform's
  // vocabulary also holds validated_fixed and false_positive: the first
  // belongs to a door that verified the fix in the running system, which this
  // runner cannot do because it cannot deploy, and the second is a judgement
  // about the request that the agent is not asked to make. Reporting
  // validated_fixed for an unmerged draft pull request put "reported
  // validated fixed for this card" on the card for a change nothing had run.
  const result = {
    outcome: 'not_validated',
    summary: '',
    actions: [],
    evidence: { runner_version: `v${config.version}`, model: config.model },
  };

  try {
    const brief = await fetchBrief(job);
    result.actions.push('fetched the brief');
    log('info', `fetched the brief for handoff ${job.handoff_id}`, { bytes: Buffer.byteLength(brief) });

    const repo = job.repo_full_name ? parseRepo(job.repo_full_name) : null;
    const workspace = repo ? await prepareCheckout(config, job, repo) : prepareScratch(config);
    if (repo) {
      result.evidence.repository = repo.fullName;
      result.evidence.branch = workspace.branch;
      result.actions.push(`checked out ${repo.fullName} at ${workspace.defaultBranch} on ${workspace.branch}`);
    } else {
      result.actions.push('ran without a checkout, because the request named no repository');
    }

    writeAgent(config, workspace.dir);
    const agent = await runAgent(config, workspace.dir, brief);
    result.actions.push(`ran opencode with agent sre-fix and model ${config.model}`);
    result.evidence.agent_exit_code = agent.code;
    if (agent.errors.length > 0) result.evidence.agent_errors = agent.errors;

    if (agent.timedOut) {
      result.summary = `The agent was stopped after SRE_RUN_TIMEOUT_SECONDS (${config.runTimeoutSeconds} seconds) and nothing was published.`;
      result.evidence.timed_out = true;
      return;
    }

    // The agent's own message travels furthest of anything this runner
    // produces: it becomes the report's summary, the card comment and the
    // pull request body. It goes through the same redaction as the lines the
    // runner writes itself, or a credential the agent happened to print would
    // be the one place the redaction did not reach.
    agent.finalMessage = redact(agent.finalMessage);
    result.summary = agent.finalMessage || 'The agent produced no final message.';

    if (agent.code !== 0) {
      result.summary = `The agent exited ${agent.code} and nothing was published. ${result.summary}`;
      // The tail rather than the whole stream: a failed run's last words are
      // what names the cause, and the platform caps an entry at a kilobyte.
      if (agent.stderr.trim()) result.evidence.agent_stderr = redact(agent.stderr).trim().slice(-1000);
      return;
    }
    if (isDecline(agent.finalMessage)) {
      result.actions.push('the agent declined, so nothing was published');
      return;
    }
    if (!repo) {
      // An untargeted request is answered with a diagnosis and evidence: there
      // is nothing checked out to change, and picking a repository from a list
      // would put a routing decision in the runner.
      result.actions.push('answered with a diagnosis, because there was no repository to change');
      return;
    }

    const { changed, flagged } = await stageAndGate(workspace.dir);
    if (changed.length === 0) {
      result.actions.push('the agent left the working tree unchanged, so nothing was published');
      return;
    }
    result.evidence.changed_files = changed;

    if (flagged.length > 0) {
      result.evidence.flagged_paths = flagged;
      result.summary = `${result.summary}\n\nNothing was published: the change touched ${flagged.join(', ')}, which the protected paths gate refuses.`;
      result.actions.push(`the protected paths gate refused ${flagged.join(', ')}`);
      log('error', `the protected paths gate refused ${flagged.join(', ')}; nothing was pushed`);
      return;
    }

    result.pr_url = await publish(config, workspace, agent.finalMessage, brief, result);
    result.actions.push(`opened ${result.pr_url}`);
    // The outcome stays not_validated and carries the pull request. The
    // agent's contract is to leave no change in place that does not build or
    // pass, so its own message says what it ran; that is a claim about the
    // checkout, not about the running system, and the change is an unmerged
    // draft until a person merges it.
    result.summary = `${result.summary}\n\nThis is an unmerged pull request, ${result.pr_url}. Nothing has verified the change in a running system.`;
    log('info', `opened ${result.pr_url} for handoff ${job.handoff_id}`);
  } catch (error) {
    result.summary = `The runner could not complete this request: ${redact(error.message)}`;
    result.evidence.error = redact(error.message);
    log('error', `handoff ${job.handoff_id} failed: ${redact(error.message)}`);
  } finally {
    await report(job, result);
    jobSecret = null;
  }
}

async function main() {
  const config = loadConfig();
  constantSecrets.push(config.apiKey);
  if (config.githubToken) constantSecrets.push(config.githubToken);
  logLevel = LEVELS[(process.env.SRE_LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

  log('info', `sre-agent-opencode fix runner v${config.version} polling ${config.serverUrl}`);

  for (;;) {
    let jobs = [];
    try {
      jobs = await poll(config);
    } catch (error) {
      if (error.fatal) throw error;
      log('error', error.message);
    }
    for (const job of jobs) {
      await handleJob(config, job);
    }
    if (config.once) return;
  }
}

process.on('uncaughtException', (error) => {
  log('error', `the runner stopped on an unhandled error: ${redact(error.stack || error.message)}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log('error', `the runner stopped on an unhandled rejection: ${redact((error && error.stack) || error)}`);
  process.exit(1);
});

main().catch((error) => {
  log('error', redact(error.message));
  process.exitCode = 1;
});
