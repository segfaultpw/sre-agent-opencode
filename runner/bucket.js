'use strict';
// The memory's mirror in the operator's own S3 bucket (SRE_MEMORY_BUCKET), and
// the restore of it onto a volume that has none.
//
// The volume is the source of truth and the bucket follows it, one way. After a
// run the files it added, changed or removed are copied or deleted under the
// prefix; nothing is ever read back except once at start, onto an empty
// <workspace>/memory, so a replaced file system gets its notes and scripts
// again. An edit made in the bucket is overwritten by the next mirror of that
// file and is read only by a restore.
//
// Everything here runs in the runner's process with the runner's own
// environment, through the `run` function the runner hands in (an argument
// array, never a shell). The agent's environment holds none of this, and what
// comes out of the bucket is judged as strictly as what the agent leaves in its
// working copy: a name, a size, a link, a special file or a reserved name that
// breaks a bound never stays on the volume.
//
// Standard library only.
const fs = require('node:fs');
const path = require('node:path');
const memory = require('./memory.js');

const DEFAULT_PREFIX = 'memory/';
const PREFIX_MAX = 512;
const RESTORE_TIMEOUT_MS = 600_000;
const CALL_TIMEOUT_MS = 120_000;
const ERROR_MAX = 300;
const DETAIL_MAX = 120;
// replaceMemory (runner.js) builds a new directory as <name>.sre-agent-new-<pid>
// and sets the old one aside as <name>.sre-agent-old-<pid>. Neither is memory.
const LEFTOVER = /\.sre-agent-(new|old)-\d+$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isLeftover(name) {
  return LEFTOVER.test(name);
}

function show(value) {
  const text = JSON.stringify(String(value));
  return text.length > 60 ? `${text.slice(0, 57)}..."` : text;
}

function bucketProblem(name) {
  if (/[/:]/.test(name)) return 'it is the bucket\'s name alone, not a URL, an ARN or a path';
  if (name.length < 3 || name.length > 63) return 'it is 3 to 63 characters long';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    return 'it uses lower case letters, digits, dots and hyphens only, and starts and ends with a letter or a digit';
  }
  if (name.includes('..')) return 'it has no two dots in a row';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return 'it is not written like an IP address';
  if (/^(xn--|sthree-|amzn-s3-demo-)/.test(name) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(name)) {
    return 'it does not use a prefix or suffix S3 reserves';
  }
  return null;
}

function normalisePrefix(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PREFIX;
  if (raw.startsWith('/')) throw new Error(`SRE_MEMORY_PREFIX ${show(raw)} is not usable: it is relative to the bucket, so it does not start with /`);
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed.length + 1 > PREFIX_MAX) throw new Error(`SRE_MEMORY_PREFIX is not usable: it is at most ${PREFIX_MAX} characters`);
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`SRE_MEMORY_PREFIX ${show(raw)} is not usable: it has no empty, . or .. part`);
    }
    if (!PREFIX_SEGMENT.test(segment)) {
      throw new Error(`SRE_MEMORY_PREFIX ${show(raw)} is not usable: each part uses letters, digits, dots, underscores and hyphens only`);
    }
  }
  return `${trimmed}/`;
}

// {bucket, prefix} from the environment: bucket '' when none is configured
// (nothing is called then), otherwise both validated, the prefix relative and
// ending in a slash. Throws an Error whose message is the sentence to print.
function fromEnv(env) {
  const name = env.SRE_MEMORY_BUCKET;
  if (name === undefined || name === '') return { bucket: '', prefix: '' };
  const problem = bucketProblem(name);
  if (problem) throw new Error(`SRE_MEMORY_BUCKET ${show(name)} is not a usable S3 bucket name: ${problem}`);
  return { bucket: name, prefix: normalisePrefix(env.SRE_MEMORY_PREFIX) };
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function entries(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function say(config, level, message) {
  if (typeof config.log === 'function') config.log(level, message);
}

function firstLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((candidate) => candidate.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return Array.from(line || '').slice(0, DETAIL_MAX).join('');
}

function failureText(result) {
  if (result.timedOut) return 'the call timed out';
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`;
}

// A memory file's path under <workspace>/memory, judged by shape: _estate or
// <owner>/<repo>, then NOTES.md or scripts/<name>, every part a legal name and
// the first not one of the runner's own directories.
function classify(rel) {
  if (typeof rel !== 'string' || rel === '') return { error: 'the path is empty' };
  const segments = rel.split('/');
  if (segments.some(isLeftover)) return { leftover: true };
  if (!segments.every(memory.validName)) return { error: 'a part of the path is outside A-Z a-z 0-9 . _ - or longer than 100 characters' };
  if (memory.RESERVED.has(segments[0])) return { error: `${segments[0]} is not a memory directory` };
  let rest;
  if (segments[0] === memory.ESTATE) {
    rest = segments.slice(1);
  } else {
    if (segments.length < 3) return { error: 'a repository\'s memory is <owner>/<repo>/NOTES.md or scripts/<name>' };
    rest = segments.slice(2);
  }
  if (rest.length === 1 && rest[0] === memory.NOTES) return { segments };
  if (rest.length === 2 && rest[0] === memory.SCRIPTS) return { segments };
  return { error: `only ${memory.NOTES} and ${memory.SCRIPTS}/<name> are memory` };
}

function sourceFile(config, segments) {
  const root = path.join(path.resolve(config.workspace), 'memory');
  const local = path.join(root, ...segments);
  const stat = lstatOrNull(local);
  if (!stat) return { error: 'the file is not on the volume' };
  if (!stat.isFile()) return { error: 'it is not a regular file' };
  const real = fs.realpathSync(local);
  const realRoot = fs.realpathSync(root);
  if (!real.startsWith(`${realRoot}${path.sep}`)) return { error: 'it resolves outside the memory directory' };
  return { local };
}

// After a run: one `aws s3 cp` per added or modified file and one `aws s3 rm`
// per removed one, keys under the prefix. A failing call is logged and the rest
// still run; the answer says how many failed so the report can. Nothing here
// ever throws into the request.
async function mirror(config, changes) {
  if (!config || !config.bucket) return { ok: true, skipped: 'no bucket is configured' };
  const list = Array.isArray(changes) ? changes : [];
  const refused = [];
  const failed = [];
  let calls = 0;
  for (const change of list) {
    const rel = change && change.path;
    const kind = change && change.change;
    const shape = classify(rel);
    if (shape.leftover) continue;
    if (shape.error) {
      refused.push(`${firstLine(rel) || '(empty)'}: ${shape.error}`);
      continue;
    }
    const uri = `s3://${config.bucket}/${config.prefix}${shape.segments.join('/')}`;
    let args;
    if (kind === 'added' || kind === 'modified') {
      const source = sourceFile(config, shape.segments);
      if (source.error) {
        refused.push(`${rel}: ${source.error}`);
        continue;
      }
      args = ['s3', 'cp', source.local, uri, '--only-show-errors'];
    } else if (kind === 'removed') {
      args = ['s3', 'rm', uri, '--only-show-errors'];
    } else {
      refused.push(`${rel}: ${firstLine(kind) || '(none)'} is not a change the mirror knows`);
      continue;
    }
    calls += 1;
    let result;
    try {
      result = await config.run('aws', args, { timeoutMs: CALL_TIMEOUT_MS });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error.message, timedOut: false };
    }
    if (result.code !== 0) failed.push(`aws s3 ${args[1]} ${rel}: ${failureText(result)}`);
  }

  for (const problem of refused) say(config, 'warn', `memory bucket: not mirrored, ${problem}`);
  for (const problem of failed) say(config, 'warn', `memory bucket: ${problem}`);
  if (failed.length === 0 && refused.length === 0) {
    if (calls > 0) say(config, 'info', `memory bucket: mirrored ${calls} change${calls === 1 ? '' : 's'} to s3://${config.bucket}/${config.prefix}`);
    return { ok: true, calls };
  }
  const parts = [];
  if (failed.length > 0) parts.push(`${failed.length} of ${calls} aws calls failed (first: ${failed[0]})`);
  if (refused.length > 0) parts.push(`${refused.length} path${refused.length === 1 ? '' : 's'} not mirrored (first: ${refused[0]})`);
  return { ok: false, calls, error: Array.from(parts.join('; ')).slice(0, ERROR_MAX).join('') };
}

// A leaf directory (_estate, or <owner>/<repo>) as restored from the bucket.
// Returns the number of files kept.
function settleLeaf(dir, label, notes) {
  for (const note of memory.enforce(dir, new Map()).notes) notes.push(`${label}: ${note}`);
  const snap = memory.snapshot(dir);
  const problems = memory.check(snap);
  if (problems.length > 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    notes.push(`${label} was removed: ${problems.join('; ')}`);
    return 0;
  }
  if (snap.size === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return 0;
  }
  fs.chmodSync(dir, 0o700);
  const scripts = path.join(dir, memory.SCRIPTS);
  if (lstatOrNull(scripts)) fs.chmodSync(scripts, 0o700);
  for (const [rel, entry] of snap) {
    const executable = rel.startsWith(`${memory.SCRIPTS}/`) && entry.content.subarray(0, 2).toString('latin1') === '#!';
    fs.chmodSync(path.join(dir, ...rel.split('/')), executable ? 0o700 : 0o600);
  }
  return snap.size;
}

// Everything under the restored root that is not a legal memory directory is
// removed without being followed: a link is unlinked, never entered.
function settleRestored(root) {
  const notes = [];
  let files = 0;
  const drop = (target, label, reason) => {
    fs.rmSync(target, { recursive: true, force: true });
    notes.push(`${label} was removed: ${reason}`);
  };
  const legal = (name) => memory.validName(name) && !memory.RESERVED.has(name) && !isLeftover(name);
  for (const name of entries(root)) {
    const top = path.join(root, name);
    const stat = lstatOrNull(top);
    if (!stat) continue;
    if (!stat.isDirectory()) {
      drop(top, name, 'it is not a directory');
    } else if (!legal(name)) {
      drop(top, name, 'it is not the name of a memory directory');
    } else if (name === memory.ESTATE) {
      files += settleLeaf(top, name, notes);
    } else {
      for (const repo of entries(top)) {
        const leaf = path.join(top, repo);
        const label = `${name}/${repo}`;
        const leafStat = lstatOrNull(leaf);
        if (!leafStat) continue;
        if (!leafStat.isDirectory()) drop(leaf, label, 'it is not a directory');
        else if (!legal(repo)) drop(leaf, label, 'it is not the name of a repository');
        else files += settleLeaf(leaf, label, notes);
      }
      if (entries(top).length === 0) fs.rmSync(top, { recursive: true, force: true });
      else fs.chmodSync(top, 0o700);
    }
  }
  return { files, notes };
}

function emptyOut(root) {
  for (const name of entries(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// Once, before the first poll, and only when <workspace>/memory is missing or
// empty: one recursive copy of the prefix into it, then the bounds. A download
// that fails leaves the directory empty, so the next start tries again.
async function restoreIfEmpty(config) {
  if (!config || !config.bucket) return { skipped: 'no bucket is configured' };
  const root = path.join(path.resolve(config.workspace), 'memory');
  const stat = lstatOrNull(root);
  if (stat && !stat.isDirectory()) {
    const reason = `${root} is not a directory, so nothing was restored into it`;
    say(config, 'warn', `memory bucket: ${reason}`);
    return { skipped: reason };
  }
  if (stat && entries(root).length > 0) {
    const reason = 'the memory directory is not empty, and the bucket is only read onto an empty one';
    say(config, 'info', `memory bucket: not restored: ${reason}`);
    return { skipped: reason };
  }
  fs.mkdirSync(root, { recursive: true });

  const source = `s3://${config.bucket}/${config.prefix}`;
  let result;
  try {
    result = await config.run('aws', ['s3', 'cp', '--recursive', source, `${root}/`, '--only-show-errors'], { timeoutMs: RESTORE_TIMEOUT_MS });
  } catch (error) {
    result = { code: null, stdout: '', stderr: error.message, timedOut: false };
  }
  if (result.code !== 0) {
    emptyOut(root);
    const reason = `the download from ${source} failed (${failureText(result)}), so the memory was not restored`;
    say(config, 'warn', `memory bucket: ${reason}`);
    return { skipped: reason };
  }

  const settled = settleRestored(root);
  for (const note of settled.notes) say(config, 'warn', `memory bucket: ${note}`);
  say(config, 'info', `memory bucket: restored ${settled.files} memory file${settled.files === 1 ? '' : 's'} from ${source}`);
  return { restored: settled.files, notes: settled.notes };
}

module.exports = { fromEnv, restoreIfEmpty, mirror, isLeftover, DEFAULT_PREFIX };
