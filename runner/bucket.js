'use strict';
// The memory's mirror in the operator's own S3 bucket (SRE_MEMORY_BUCKET), and
// the restore of it onto a volume that has none.
//
// The volume is the source of truth and the bucket follows it, one way. After a
// run the files it added, changed or removed are copied or deleted under the
// prefix; nothing is ever read back except by a restore, which fills a volume
// that has no memory (and finishes a restore that has not yet succeeded), so a
// replaced file system gets its notes and scripts again. An edit made in the
// bucket is overwritten by the next mirror of that file and is read only by a
// restore.
//
// Three small files in the workspace, outside memory/, keep this honest across
// stops and failures:
//
//   .memory-restore-pending  a restore has been started and has not succeeded.
//                            Until it has, nothing is put into or deleted from
//                            the bucket, because the bucket may hold the only
//                            copy of what the volume is missing.
//   .memory-first-sync       the volume has been mirrored completely at least
//                            once to the bucket and prefix it names: its files
//                            are all there, or that is where they came from.
//                            Without it, or with one that names another bucket
//                            or prefix, the runner journals every file on the
//                            volume that passes the memory bounds for upload at
//                            start (an upgrade with memory already on the
//                            volume, or a bucket added or changed later), under
//                            the same deadline, and writes it when the journal
//                            empties. That sync only puts; it never deletes.
//   .memory-mirror-pending   the paths the volume has changed that the bucket
//                            has not been told about yet (a path is dropped
//                            from it when its call succeeds), so a failure, a
//                            stop or the mirror's time limit loses nothing: the
//                            next request carries on.
//
// A restore downloads into a staging directory beside memory/, judges what came
// back there, and only then moves it in, so memory/ never holds a byte nobody
// has judged, whatever stops the process half way.
//
// Everything here runs in the runner's process with the runner's own
// environment, through the `run` function the runner hands in (an argument
// array, never a shell). The agent's environment holds none of this, and what
// comes out of the bucket is judged as strictly as what the agent leaves in its
// working copy: a name, a size, a link or a special file that breaks a bound
// never stays on the volume.
//
// Standard library only.
const fs = require('node:fs');
const path = require('node:path');
const memory = require('./memory.js');

const DEFAULT_PREFIX = 'memory/';
const PREFIX_MAX = 512;
const RESTORE_TIMEOUT_MS = 600_000;
// A restore retried before a request is shorter, so a request is never held
// back for the length of a full restore (the platform fails one after 45
// minutes).
const RETRY_TIMEOUT_MS = 300_000;
// The whole mirror after one request, not each call: a bucket that drops
// packets would otherwise cost every call its full timeout and hold the report
// back for as long as there are paths. A call is given the time that is left,
// so one that gets no answer uses all of it and ends the mirror.
const MIRROR_DEADLINE_MS = 120_000;
const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 600_000;
const ERROR_MAX = 300;
const DETAIL_MAX = 120;
const RESTORE_MARKER = '.memory-restore-pending';
const MIRROR_JOURNAL = '.memory-mirror-pending';
const SYNC_MARKER = '.memory-first-sync';
const STALE_STATE = new RegExp(`^${memory.STATE_PREFIX.replace(/\./g, '\\.')}(restore-\\d+|[a-z-]+\\.tmp-\\d+)$`);
const KINDS = new Set(['added', 'modified', 'removed']);
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

function workspaceDir(config) {
  return path.resolve(config.workspace);
}

function memoryRoot(config) {
  return path.join(workspaceDir(config), 'memory');
}

function own(config, target) {
  if (typeof config.own === 'function') config.own(target);
}

// A directory the runner's account owns and nobody else can enter.
function ensureDir(config, dir) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  own(config, dir);
  fs.chmodSync(dir, 0o700);
}

function writeState(config, name, text) {
  const target = path.join(workspaceDir(config), name);
  const temp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(workspaceDir(config), { recursive: true });
  fs.rmSync(temp, { force: true });
  // Flushed before the rename: a rename that reaches the disk ahead of the
  // bytes it names leaves a truncated file after a host crash.
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  own(config, temp);
  fs.renameSync(temp, target);
}

function removeState(config, name) {
  fs.rmSync(path.join(workspaceDir(config), name), { force: true });
}

function stateExists(config, name) {
  return lstatOrNull(path.join(workspaceDir(config), name)) !== null;
}

// What an earlier process left half done: a staging directory or a state file
// being written. Nothing in them is ever used.
function removeStale(config) {
  for (const name of entries(workspaceDir(config))) {
    if (STALE_STATE.test(name)) fs.rmSync(path.join(workspaceDir(config), name), { recursive: true, force: true });
  }
}

function syncTarget(config) {
  return `s3://${config.bucket}/${config.prefix}`;
}

function writeSyncMarker(config) {
  writeState(config, SYNC_MARKER, `${JSON.stringify({ at: new Date().toISOString(), target: syncTarget(config) })}\n`);
}

// The marker counts for this bucket and prefix only: a volume mirrored to one
// place has not been mirrored to another. One that is empty, unreadable or
// names no target (not one this release wrote) counts for none.
function syncMarkerTarget(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceDir(config), SYNC_MARKER), 'utf8'));
    return parsed && typeof parsed.target === 'string' ? parsed.target : null;
  } catch {
    return null;
  }
}

function restorePending(config) {
  return Boolean(config && config.bucket) && stateExists(config, RESTORE_MARKER);
}

// A memory file's path under <workspace>/memory, judged by shape: _estate or
// <owner>/<repo>, then NOTES.md or scripts/<name>, every part a legal name. The
// names the runner keeps at the top of the workspace (repos, gitdirs, scratch,
// agent-home, memory) are ordinary owners here, because the memory root is
// below them and nothing written under it can reach them.
function classify(rel) {
  if (typeof rel !== 'string' || rel === '') return { error: 'the path is empty' };
  const segments = rel.split('/');
  if (segments.some(isLeftover)) return { leftover: true };
  if (!segments.every(memory.validName)) return { error: 'a part of the path is outside A-Z a-z 0-9 . _ - or longer than 100 characters' };
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
  const root = memoryRoot(config);
  const local = path.join(root, ...segments);
  const stat = lstatOrNull(local);
  if (!stat) return { error: 'the file is not on the volume' };
  if (!stat.isFile()) return { error: 'it is not a regular file' };
  const real = fs.realpathSync(local);
  const realRoot = fs.realpathSync(root);
  if (!real.startsWith(`${realRoot}${path.sep}`)) return { error: 'it resolves outside the memory directory' };
  return { local };
}

// The paths the volume has changed that the bucket has not been told about:
// path -> added | modified | removed, the latest change winning.
function loadJournal(config) {
  const journal = new Map();
  const file = path.join(workspaceDir(config), MIRROR_JOURNAL);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return journal;
    return lostJournal(config, file, error.message, journal);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return lostJournal(config, file, error.message, journal);
  }
  // A journal is never written empty (saveJournal removes the file instead), so
  // one without its paths object is not a journal.
  if (!parsed || typeof parsed !== 'object' || !parsed.paths || typeof parsed.paths !== 'object') {
    return lostJournal(config, file, 'it has no list of paths', journal);
  }
  for (const [rel, kind] of Object.entries(parsed.paths)) {
    if (KINDS.has(kind) && classify(rel).segments) journal.set(rel, kind);
  }
  return journal;
}

// A journal that cannot be read (a write that never reached the disk, a file
// something else damaged) has lost the paths the bucket was still to be told
// about. Uploads are idempotent, so the answer is to forget the first sync's
// marker and let the next one put every file on the volume into a new journal.
function lostJournal(config, file, reason, journal) {
  say(config, 'warn', `memory bucket: the journal of paths still to be mirrored could not be read (${firstLine(reason)}); it is removed and every file on the volume is mirrored again`);
  try {
    fs.rmSync(file, { recursive: true, force: true });
    removeState(config, SYNC_MARKER);
  } catch (error) {
    say(config, 'warn', `memory bucket: the unreadable journal could not be removed (${firstLine(error.message)})`);
  }
  if (config.state) config.state.syncing = false;
  journal.lost = true;
  return journal;
}

function saveJournal(config, journal) {
  if (journal.size === 0) {
    removeState(config, MIRROR_JOURNAL);
    return;
  }
  const paths = {};
  for (const rel of [...journal.keys()].sort()) paths[rel] = journal.get(rel);
  writeState(config, MIRROR_JOURNAL, `${JSON.stringify({ version: 1, paths })}\n`);
}

// After a run: one `aws s3 cp` per added or modified file and one `aws s3 rm`
// per removed one, keys under the prefix, for these changes and for whatever an
// earlier request left in the journal. The journal is written before the first
// call and a path leaves it when its call succeeds, so nothing a stop, a
// failure or the time limit cuts is forgotten. While a restore has not
// succeeded the calls are not made at all. A failing call is logged and the
// rest still run; one that times out has used all the time that was left, so it
// ends the mirror, because the bucket is not answering. Nothing here ever
// throws into the request.
async function mirror(config, changes) {
  if (!config || !config.bucket) return { ok: true, skipped: 'no bucket is configured' };
  const refused = [];
  let journal = loadJournal(config);
  if (journal.lost) {
    // The paths it held are gone: journal the whole volume now, so this request
    // carries them to the bucket instead of the next one.
    firstSync(config);
    journal = loadJournal(config);
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    const rel = change && change.path;
    const kind = change && change.change;
    const shape = classify(rel);
    if (shape.leftover) continue;
    if (shape.error) {
      refused.push(`${firstLine(rel) || '(empty)'}: ${shape.error}`);
    } else if (!KINDS.has(kind)) {
      refused.push(`${rel}: ${firstLine(kind) || '(none)'} is not a change the mirror knows`);
    } else {
      journal.set(rel, kind);
    }
  }
  const refusedText = () => (refused.length > 0 ? `${refused.length} path${refused.length === 1 ? '' : 's'} not mirrored (first: ${refused[0]})` : '');
  for (const problem of refused) say(config, 'warn', `memory bucket: not mirrored, ${problem}`);
  if (journal.size === 0 && refused.length === 0) return { ok: true, calls: 0, idle: true };
  if (journal.size === 0) return { ok: false, calls: 0, pending: 0, error: Array.from(refusedText()).slice(0, ERROR_MAX).join('') };

  saveJournal(config, journal);
  if (restorePending(config)) {
    const error = `the restore from the bucket has not succeeded, so nothing was mirrored (${journal.size} path${journal.size === 1 ? '' : 's'} wait for it)`;
    say(config, 'warn', `memory bucket: ${error}`);
    return { ok: false, calls: 0, pending: journal.size, error: Array.from(error).slice(0, ERROR_MAX).join('') };
  }

  const total = journal.size;
  const deadlineMs = Number.isFinite(config.deadlineMs) && config.deadlineMs > 0 ? config.deadlineMs : MIRROR_DEADLINE_MS;
  const started = Date.now();
  const failed = [];
  let calls = 0;
  let notTried = 0;
  for (const rel of [...journal.keys()].sort()) {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      notTried += 1;
      continue;
    }
    const shape = classify(rel);
    const uri = `s3://${config.bucket}/${config.prefix}${shape.segments.join('/')}`;
    const kind = journal.get(rel);
    let args;
    if (kind === 'removed') {
      args = ['s3', 'rm', uri, '--only-show-errors'];
    } else {
      const source = sourceFile(config, shape.segments);
      if (source.error) {
        refused.push(`${rel}: ${source.error}`);
        say(config, 'warn', `memory bucket: not mirrored, ${rel}: ${source.error}`);
        journal.delete(rel);
        continue;
      }
      args = ['s3', 'cp', source.local, uri, '--only-show-errors'];
    }
    calls += 1;
    let result;
    try {
      result = await config.run('aws', args, { timeoutMs: remaining });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error.message, timedOut: false };
    }
    if (result.code === 0) {
      journal.delete(rel);
      saveJournal(config, journal);
    } else {
      failed.push(`aws s3 ${args[1]} ${rel}: ${failureText(result)}`);
    }
  }
  saveJournal(config, journal);
  if (journal.size === 0 && config.state && config.state.syncing) {
    writeSyncMarker(config);
    config.state.syncing = false;
    say(config, 'info', 'memory bucket: the first sync of the volume to the bucket is complete');
  }

  for (const problem of failed) say(config, 'warn', `memory bucket: ${problem}`);
  const pending = journal.size;
  if (failed.length === 0 && notTried === 0 && refused.length === 0) {
    if (calls > 0) say(config, 'info', `memory bucket: mirrored ${calls} change${calls === 1 ? '' : 's'} to s3://${config.bucket}/${config.prefix}`);
    return { ok: true, calls, pending: 0 };
  }
  const parts = [];
  if (failed.length > 0) parts.push(`${failed.length} of ${calls} aws calls failed (first: ${failed[0]})`);
  if (notTried > 0) {
    parts.push(`${notTried} of ${total} not tried: the mirror stops after ${Math.round(deadlineMs / 1000)} s or at the first call that gets no answer, and they wait for the next request`);
  }
  if (refused.length > 0) parts.push(refusedText());
  const error = Array.from(parts.join('; ')).slice(0, ERROR_MAX).join('');
  if (notTried > 0 || failed.length > 0) say(config, 'warn', `memory bucket: ${pending} path${pending === 1 ? ' is' : 's are'} still waiting to be mirrored`);
  return { ok: false, calls, pending, error };
}

// A leaf directory (_estate, or <owner>/<repo>) as restored from the bucket.
// Returns the number of files kept. enforce is the whole judgement: after it
// the directory holds NOTES.md and scripts/<name> within the bounds.
function settleLeaf(dir, label, notes) {
  for (const note of memory.enforce(dir, new Map()).notes) notes.push(`${label}: ${note}`);
  const snap = memory.snapshot(dir);
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
  const legal = (name) => memory.validName(name) && !isLeftover(name);
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

// The leaves of a judged tree: [{label, dir}], label being the path below the
// memory root.
function leavesOf(root) {
  const leaves = [];
  for (const name of entries(root)) {
    const top = path.join(root, name);
    if (name === memory.ESTATE) {
      leaves.push({ label: name, dir: top });
    } else {
      for (const repo of entries(top)) leaves.push({ label: `${name}/${repo}`, dir: path.join(top, repo) });
    }
  }
  return leaves;
}

// Puts a judged tree on the volume. Onto an empty memory directory the tree
// simply becomes it, in one rename. Onto one that holds something (a job wrote
// while the restore was failing), only files the volume lacks are moved in: the
// volume wins, and a path the journal lists is the volume's even when it is
// gone from it. Whatever is added is held to the bounds again, with what the
// volume already had winning the places.
function moveIn(config, staging, notes) {
  const root = memoryRoot(config);
  const rootStat = lstatOrNull(root);
  if (!rootStat || entries(root).length === 0) {
    if (rootStat) fs.rmdirSync(root);
    fs.renameSync(staging, root);
    return;
  }
  const journal = loadJournal(config);
  for (const { label, dir } of leavesOf(staging)) {
    const target = path.join(root, ...label.split('/'));
    const had = memory.snapshot(target);
    let added = 0;
    for (const rel of memory.snapshot(dir).keys()) {
      const full = `${label}/${rel}`;
      const place = path.join(target, ...rel.split('/'));
      if (journal.has(full) || lstatOrNull(place)) continue;
      let current = root;
      for (const part of path.dirname(path.join(label, rel)).split(path.sep)) {
        current = path.join(current, part);
        ensureDir(config, current);
      }
      fs.renameSync(path.join(dir, ...rel.split('/')), place);
      added += 1;
    }
    if (added > 0) {
      for (const note of memory.enforce(target, had).notes) notes.push(`${label}: ${note}`);
    }
  }
}

// One attempt: download into the staging directory, judge it there, move it in.
// Any failure leaves memory/ as it was and the restore pending.
async function attempt(config, timeoutMs) {
  const staging = path.join(workspaceDir(config), `${memory.STATE_PREFIX}restore-${process.pid}`);
  const source = `s3://${config.bucket}/${config.prefix}`;
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(config, staging);
  try {
    let result;
    try {
      result = await config.run('aws', ['s3', 'cp', '--recursive', source, `${staging}/`, '--only-show-errors'], { timeoutMs });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error.message, timedOut: false };
    }
    // 2 is the CLI's "finished, but skipped something" (a key that climbs out of
    // the destination, an archived object): what it did download is judged and
    // kept, and the skip is logged.
    if (result.code !== 0 && result.code !== 2) {
      const reason = `the download from ${source} failed (${failureText(result)}), so the memory was not restored; it is tried again before the next request`;
      say(config, 'warn', `memory bucket: ${reason}`);
      return { skipped: reason };
    }
    if (result.code === 2) {
      say(config, 'warn', `memory bucket: the download from ${source} skipped something: ${failureText(result)}`);
    }
    const settled = settleRestored(staging);
    moveIn(config, staging, settled.notes);
    removeState(config, RESTORE_MARKER);
    // What the volume has now came from the bucket, apart from what the journal
    // lists, so there is nothing to sync for the first time.
    writeSyncMarker(config);
    for (const note of settled.notes) say(config, 'warn', `memory bucket: ${note}`);
    say(config, 'info', `memory bucket: restored ${settled.files} memory file${settled.files === 1 ? '' : 's'} from ${source}`);
    return { restored: settled.files, notes: settled.notes };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// At start, before the first poll: fills <workspace>/memory from the bucket
// when it is missing or empty, and finishes a restore an earlier process
// started and did not complete (the marker says so) even when memory/ has
// something in it by now. A volume that holds memory and no marker is never
// restored over and the bucket is not read.
async function restore(config, options = {}) {
  if (!config || !config.bucket) return { skipped: 'no bucket is configured' };
  fs.mkdirSync(workspaceDir(config), { recursive: true });
  removeStale(config);
  const root = memoryRoot(config);
  const stat = lstatOrNull(root);
  if (stat && !stat.isDirectory()) {
    const reason = `${root} is not a directory, so nothing was restored into it`;
    say(config, 'warn', `memory bucket: ${reason}`);
    return { skipped: reason };
  }
  const pending = stateExists(config, RESTORE_MARKER);
  if (!pending && stat && entries(root).length > 0) {
    const reason = 'the memory directory is not empty, and the bucket is only read onto an empty one';
    say(config, 'info', `memory bucket: not restored: ${reason}`);
    return { skipped: reason };
  }
  if (!pending) writeState(config, RESTORE_MARKER, `${JSON.stringify({ since: new Date().toISOString() })}\n`);
  return attempt(config, options.timeoutMs || RESTORE_TIMEOUT_MS);
}

// The files on the volume that are memory and inside the bounds, by path below
// memory/, without reading any of them: names and sizes only. What breaks a
// bound (a note over 65,536 bytes, the scripts after the fiftieth, the largest
// files of a directory over 1 MiB) is left out, counted in `skipped`, because a
// restore would judge it away and the bucket should not hold what the volume's
// own rules refuse. A link or another special file is skipped here and refused
// again by the mirror.
function memoryFiles(config) {
  const root = memoryRoot(config);
  const files = [];
  const skipped = [];
  const isDir = (target) => {
    const stat = lstatOrNull(target);
    return Boolean(stat && stat.isDirectory());
  };
  const sizeOfFile = (target) => {
    const stat = lstatOrNull(target);
    return stat && stat.isFile() ? stat.size : null;
  };
  if (!isDir(root)) return { files, skipped };
  for (const name of entries(root)) {
    const top = path.join(root, name);
    if (!isDir(top)) continue;
    const leaves = name === memory.ESTATE ? [[name, top]] : entries(top).map((repo) => [`${name}/${repo}`, path.join(top, repo)]);
    for (const [label, dir] of leaves) {
      if (!isDir(dir)) continue;
      const candidates = [];
      const noteSize = sizeOfFile(path.join(dir, memory.NOTES));
      if (noteSize !== null) candidates.push({ rel: memory.NOTES, bytes: noteSize });
      const scripts = path.join(dir, memory.SCRIPTS);
      if (isDir(scripts)) {
        for (const script of entries(scripts)) {
          const bytes = sizeOfFile(path.join(scripts, script));
          if (bytes !== null) candidates.push({ rel: `${memory.SCRIPTS}/${script}`, bytes });
        }
      }
      const admitted = new Set(memory.admit(candidates));
      for (const candidate of candidates) {
        const rel = `${label}/${candidate.rel}`;
        if (!admitted.has(candidate.rel) || !classify(rel).segments) skipped.push(rel);
        else files.push(rel);
      }
    }
  }
  return { files, skipped };
}

// At start and before a request: a volume that has never been mirrored
// completely to this bucket and prefix (no marker, or one that names another
// place) gets every file on it that passes the memory bounds journaled for
// upload, once, and the mirror that follows works through the journal under its
// usual deadline. A cut leaves the rest pending and the marker is written only
// when the journal empties. It never deletes anything in the bucket, and it
// waits while a restore is pending, because then the bucket may hold what the
// volume lacks.
function firstSync(config) {
  if (!config || !config.bucket) return { skipped: 'no bucket is configured' };
  if (!config.state) config.state = {};
  const marked = syncMarkerTarget(config);
  if (marked === syncTarget(config)) return { skipped: 'the volume has been mirrored completely before' };
  if (restorePending(config)) return { skipped: 'a restore is pending' };
  if (config.state.syncing) return { skipped: 'the first sync is under way' };
  if (marked !== null) {
    say(config, 'info', `memory bucket: the volume was last mirrored completely to ${marked}, not to ${syncTarget(config)}, so every file is mirrored again`);
  }
  const journal = loadJournal(config);
  const found = memoryFiles(config);
  let journaled = 0;
  for (const rel of found.files) {
    if (journal.has(rel)) continue;
    journal.set(rel, 'added');
    journaled += 1;
  }
  if (found.skipped.length > 0) {
    say(config, 'warn', `memory bucket: ${found.skipped.length} file${found.skipped.length === 1 ? '' : 's'} on the volume break${found.skipped.length === 1 ? 's' : ''} the memory bounds and ${found.skipped.length === 1 ? 'is' : 'are'} not uploaded (first: ${found.skipped[0]})`);
  }
  if (journal.size === 0) {
    writeSyncMarker(config);
    return { journaled: 0, skipped: found.skipped.length };
  }
  saveJournal(config, journal);
  config.state.syncing = true;
  say(config, 'info', `memory bucket: ${journaled} file${journaled === 1 ? '' : 's'} on the volume ${journaled === 1 ? 'was' : 'were'} never mirrored; they are uploaded with the next request`);
  return { journaled, skipped: found.skipped.length };
}

// Before a request, while a restore has not succeeded: tried again at once the
// first time, then after 30 s, 60 s and so on up to ten minutes, so a bucket
// that stays unreachable costs a request one failed call, not a wait.
async function retryRestore(config) {
  if (!restorePending(config)) return null;
  if (!config.state) config.state = {};
  const state = config.state;
  if (state.retryAt && Date.now() < state.retryAt) return { skipped: 'waiting before the restore is tried again' };
  let result;
  try {
    result = await restore(config, { timeoutMs: RETRY_TIMEOUT_MS });
  } catch (error) {
    // A volume that cannot be written is as much a failed try as a bucket that
    // cannot be read: back off instead of paying for it before every request.
    say(config, 'warn', `memory bucket: the restore could not be finished (${firstLine(error.message)}); it stays pending`);
    result = { skipped: error.message };
  }
  if (result.restored === undefined) {
    state.failures = (state.failures || 0) + 1;
    state.retryAt = Date.now() + Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (state.failures - 1), RETRY_BACKOFF_MAX_MS);
  } else {
    state.failures = 0;
    state.retryAt = 0;
  }
  return result;
}

module.exports = { fromEnv, restore, retryRestore, restorePending, firstSync, mirror, isLeftover, DEFAULT_PREFIX };
