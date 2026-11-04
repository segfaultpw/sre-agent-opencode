#!/usr/bin/env node
'use strict';

// Runs SRE_CONCURRENCY workers of the fix runner in one container or on one
// machine. Each worker is a complete runner process of its own (runner.js),
// with its own instance id (<name>-<n>), its own directory under
// <workspace>/instances/, its own poll and its own heartbeat: nothing is shared
// in memory, and what the pool already shares on disk (the memory tree, the
// per-repository locks, the state locks) is what keeps two workers off one
// repository. The platform sees N instances, each with the leases and the
// repository-busy rule it already applies to a pool.
//
// The entrypoint starts this only for SRE_CONCURRENCY above 1; at 1 or unset it
// starts runner.js directly, exactly as before.
//
// Standard library only, like the runner.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const memory = require('./memory.js');

const MIN_WORKERS = 1;
const MAX_WORKERS = 8;
const RESTART_DELAY_MS = 5_000;
const RESTART_WINDOW_MS = 60_000;
const RESTART_LIMIT = 10;
// How long a worker gets to finish after SIGTERM before it is killed.
const STOP_GRACE_MS = 30_000;
// The name rule memory.instanceId applies, and its length bound.
const INSTANCE_MAX = 100;

function stamp(level, message) {
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(`${new Date().toISOString()} ${level} supervisor: ${message}\n`);
}

// 1 to 8 as plain digits, or null. "01", "2.0", " 3", "0" and "9" are not.
function parseConcurrency(raw) {
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-8]$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

// The worker ids: the base (SRE_RUNNER_INSTANCE, else the hostname, else
// default; the same choice the runner makes) with -1 to -K, the base cut so the
// whole id stays within the length the runner accepts.
function workerInstances(base, count) {
  const suffixRoom = INSTANCE_MAX - String(count).length - 1;
  const stem = base.length > suffixRoom ? base.slice(0, suffixRoom) : base;
  return Array.from({ length: count }, (_, index) => `${stem}-${index + 1}`);
}

// One agent account per worker. The agent has a shell and is isolated from the
// runner, and from every other request, only by being a different account, so
// two workers must never run their agents as one account: one's cleanup (it
// ends every process of the account) would end the other's run, and the other
// could read its environment, checkout and home. When the account split is on
// (SRE_AGENT_UID is set) the entrypoint hands over account n as
// SRE_AGENT_<n>_UID, _GID, _HOME and _USER for n = 1..K, and a start with fewer
// accounts than workers is refused, never shared. With the split off there is
// no agent account and nothing to hand over. Answers null (split off), an array
// of { uid, gid, home, user } or throws an Error whose message is the refusal.
function workerAccounts(env, count) {
  const split = env.SRE_AGENT_UID !== undefined && env.SRE_AGENT_UID !== '';
  if (!split) return null;
  const accounts = [];
  for (let n = 1; n <= count; n += 1) {
    const read = (name) => (n === 1 && env[`SRE_AGENT_${n}_${name}`] === undefined ? env[`SRE_AGENT_${name}`] : env[`SRE_AGENT_${n}_${name}`]);
    const uid = read('UID');
    const gid = read('GID');
    const home = read('HOME');
    if (!/^[0-9]+$/.test(uid || '') || !/^[0-9]+$/.test(gid || '') || !path.isAbsolute(home || '')) {
      throw new Error(`SRE_CONCURRENCY=${count} needs ${count} agent accounts, one for each worker, and the account for worker ${n} is not configured (the container image and the systemd installer make ${MAX_WORKERS}: the agent account and ${env.SRE_AGENT_USER || 'agent'}-2 to -${MAX_WORKERS}); a worker never shares an agent account with another, so lower SRE_CONCURRENCY or add the account`);
    }
    accounts.push({ uid: Number.parseInt(uid, 10), gid: Number.parseInt(gid, 10), home, user: read('USER') || '' });
  }
  const runnerUid = /^[0-9]+$/.test(env.SRE_RUNNER_UID || '') ? Number.parseInt(env.SRE_RUNNER_UID, 10) : process.getuid();
  const runnerGid = /^[0-9]+$/.test(env.SRE_RUNNER_GID || '') ? Number.parseInt(env.SRE_RUNNER_GID, 10) : process.getgid();
  const uids = new Set(accounts.map((account) => account.uid));
  const gids = new Set(accounts.map((account) => account.gid));
  if (uids.size !== accounts.length || gids.size !== accounts.length) {
    throw new Error('the agent accounts of the workers must have a user id and a group id each of their own, and two of them share one');
  }
  if (uids.has(runnerUid) || gids.has(runnerGid) || uids.has(0)) {
    throw new Error('an agent account of a worker is the runner\'s own account or root; the agent accounts must be distinct from the runner and from each other');
  }
  return accounts;
}

// Output of a worker, one line at a time, each with the worker's id in front so
// that eight interleaved logs can still be told apart.
function prefixLines(stream, target, label) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let at = pending.indexOf('\n');
    while (at !== -1) {
      target.write(`[${label}] ${pending.slice(0, at)}\n`);
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (pending) target.write(`[${label}] ${pending}\n`);
    pending = '';
  });
}

function main(env = process.env) {
  const count = parseConcurrency(env.SRE_CONCURRENCY);
  if (count === null) {
    process.stderr.write(
      `sre-agent-fix-runner: SRE_CONCURRENCY must be a whole number from ${MIN_WORKERS} to ${MAX_WORKERS} (it is ${JSON.stringify(String(env.SRE_CONCURRENCY).slice(0, 20))}); each worker needs about one CPU and 2 GiB of memory\n`
    );
    process.exit(2);
  }

  let accounts;
  try {
    accounts = workerAccounts(env, count);
  } catch (error) {
    process.stderr.write(`sre-agent-fix-runner: ${error.message}\n`);
    process.exit(2);
  }

  const runnerPath = path.join(__dirname, 'runner.js');
  const base = memory.instanceId(env);
  const instances = workerInstances(base, count);
  const workspace = path.resolve(env.SRE_WORKSPACE || '/workspace');

  // The directory each worker works in, made here so a volume this account
  // cannot write refuses the start with a sentence, as the entrypoint does for
  // a single instance, instead of failing every worker's first job.
  for (const instance of instances) {
    const dir = path.join(workspace, 'instances', instance);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      process.stderr.write(
        `sre-agent-fix-runner: the instance directory ${dir} does not exist or is not writable by uid ${process.getuid()}; mount the workspace writable, or point SRE_WORKSPACE somewhere this account owns\n`
      );
      process.exit(1);
    }
  }

  stamp('info', `starting ${count} runner workers as ${instances.join(', ')}${accounts ? `, each with an agent account of its own (uids ${accounts.map((account) => account.uid).join(', ')})` : ''}; they share the workspace ${workspace} and the memory tree on it`);

  let stopping = false;
  let unclean = false;
  const restarts = [];
  const workers = instances.map((instance, index) => ({ instance, account: accounts ? accounts[index] : null, child: null, timer: null, exited: false }));

  const finishIfDone = () => {
    if (workers.some((worker) => worker.child || worker.timer)) return;
    process.exit(unclean ? 1 : 0);
  };

  const start = (worker) => {
    worker.timer = null;
    const childEnv = { ...env, SRE_RUNNER_INSTANCE: worker.instance, SRE_WORKSPACE_PER_INSTANCE: '1' };
    delete childEnv.SRE_CONCURRENCY;
    for (const name of Object.keys(childEnv)) {
      if (/^SRE_AGENT_[0-9]+_(UID|GID|HOME|USER)$/.test(name)) delete childEnv[name];
    }
    if (worker.account) {
      childEnv.SRE_AGENT_UID = String(worker.account.uid);
      childEnv.SRE_AGENT_GID = String(worker.account.gid);
      childEnv.SRE_AGENT_HOME = worker.account.home;
      if (worker.account.user) childEnv.SRE_AGENT_USER = worker.account.user;
    }
    const child = spawn(process.execPath, [runnerPath], { env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] });
    worker.child = child;
    prefixLines(child.stdout, process.stdout, worker.instance);
    prefixLines(child.stderr, process.stderr, worker.instance);
    let ended = false;
    child.on('error', (error) => {
      stamp('error', `worker ${worker.instance} could not be started: ${error.message}`);
      // No exit event follows a process that never started.
      if (!child.pid) onExit(1, null);
    });
    child.on('close', (code, signal) => onExit(code, signal));
    const onExit = (code, signal) => {
      if (ended) return;
      ended = true;
      worker.child = null;
      if (stopping) {
        // A stop that was asked for: a signal, or an exit, is the stop.
        if (code !== null && code !== 0) unclean = true;
        finishIfDone();
        return;
      }
      if (code === 0) {
        stamp('info', `worker ${worker.instance} finished and is not restarted`);
        finishIfDone();
        return;
      }
      const how = signal ? `was ended by ${signal}` : `exited ${code}`;
      const now = Date.now();
      while (restarts.length > 0 && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
      if (restarts.length >= RESTART_LIMIT) {
        stamp('error', `worker ${worker.instance} ${how}, and ${RESTART_LIMIT} restarts have happened in the last minute, so the supervisor gives up (a key the platform refuses does this); fix the cause and start it again`);
        unclean = true;
        stop();
        return;
      }
      restarts.push(now);
      stamp('warn', `worker ${worker.instance} ${how}; restarting it in ${RESTART_DELAY_MS / 1000} s`);
      worker.timer = setTimeout(() => start(worker), RESTART_DELAY_MS);
    };
  };

  const stop = (signal = 'SIGTERM') => {
    if (!stopping) {
      stopping = true;
      stamp('info', `stopping the workers (${signal})`);
      setTimeout(() => {
        for (const worker of workers) {
          if (worker.child) {
            stamp('error', `worker ${worker.instance} did not stop within ${STOP_GRACE_MS / 1000} s; killing it`);
            worker.child.kill('SIGKILL');
            unclean = true;
          }
        }
      }, STOP_GRACE_MS).unref();
    }
    for (const worker of workers) {
      if (worker.timer) {
        clearTimeout(worker.timer);
        worker.timer = null;
      }
      if (worker.child) worker.child.kill(signal);
    }
    finishIfDone();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  for (const worker of workers) start(worker);
}

module.exports = { parseConcurrency, workerInstances, workerAccounts, main };

if (require.main === module) {
  main();
}
