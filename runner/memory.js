'use strict';
// The runner's persistent workspace and the memory the agent keeps in it.
//
//   <workspace>/repos/<owner>/<repo>/      work trees, reused between requests
//   <workspace>/gitdirs/<owner>/<repo>/    the git directory of each work tree
//   <workspace>/memory/<owner>/<repo>/     NOTES.md and scripts/<name>
//   <workspace>/memory/_estate/            the same, for requests naming no repository
//   <workspace>/scratch/                   untargeted runs
//
// The agent never touches <workspace>/memory itself: the runner copies a memory
// directory next to the agent's work before a run and copies it back after, and
// every bound below is applied by the runner to that copy, not asked of the
// agent. Anything the agent leaves that breaks a bound is put back to what the
// previous run left (or removed when there was nothing), and the notes name it.
// Standard library only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NOTES = 'NOTES.md';
const SCRIPTS = 'scripts';
const ESTATE = '_estate';
const MAX_NOTES_BYTES = 65536;
const MAX_SCRIPTS = 50;
const MAX_DIR_BYTES = 1048576;
const MAX_CHANGES = 50;
const MAX_PATH_CHARS = 300;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 200;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Top-level names the runner owns. An old clone under an owner called one of
// these cannot be told from the runner's own directory, so it is not migrated
// and is cloned again under repos/.
const RESERVED = new Set(['repos', 'gitdirs', 'memory', 'scratch', 'agent-home']);

function validName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name) && !/^\.+$/.test(name);
}

function layout(workspace) {
  const base = path.resolve(workspace);
  return {
    repos: path.join(base, 'repos'),
    gitdirs: path.join(base, 'gitdirs'),
    memory: path.join(base, 'memory'),
    scratch: path.join(base, 'scratch'),
  };
}

function parseRepo(repo) {
  let owner;
  let name;
  if (typeof repo === 'string') {
    const parts = repo.split('/');
    if (parts.length !== 2) throw new Error(`memory: ${JSON.stringify(repo)} is not an owner/name pair`);
    [owner, name] = parts;
  } else if (repo && typeof repo === 'object') {
    ({ owner, name } = repo);
  } else {
    throw new Error('memory: a repository is an owner/name pair');
  }
  if (!validName(owner) || !validName(name) || owner === ESTATE) {
    throw new Error(`memory: ${JSON.stringify(`${owner}/${name}`)} is not a name the memory directory can use`);
  }
  return { owner, name };
}

function memoryDir(workspace, repo) {
  const { memory } = layout(workspace);
  if (repo === null || repo === undefined) return path.join(memory, ESTATE);
  const { owner, name } = parseRepo(repo);
  return path.join(memory, owner, name);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isRealDirectory(target) {
  const stat = lstatOrNull(target);
  return Boolean(stat && stat.isDirectory());
}

function readDirOrEmpty(target) {
  try {
    return fs.readdirSync(target).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

// Moves a clone from the layout before this module, <workspace>/<owner>/<repo>,
// to <workspace>/repos/<owner>/<repo>. Only a real directory holding a .git
// moves, and never onto something already there, so a second call finds
// nothing to do and a clone in the new place is never overwritten.
function migrate(workspace) {
  const base = path.resolve(workspace);
  const { repos } = layout(base);
  const moved = [];
  for (const owner of readDirOrEmpty(base)) {
    // A GitHub owner always passes validName; lost+found of a mounted disk and
    // the like do not, and may not even be readable.
    if (RESERVED.has(owner) || !validName(owner)) continue;
    const ownerDir = path.join(base, owner);
    if (!isRealDirectory(ownerDir)) continue;
    for (const name of readDirOrEmpty(ownerDir)) {
      const from = path.join(ownerDir, name);
      if (!isRealDirectory(from) || !lstatOrNull(path.join(from, '.git'))) continue;
      const to = path.join(repos, owner, name);
      if (lstatOrNull(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(`${owner}/${name}`);
    }
    if (readDirOrEmpty(ownerDir).length === 0) fs.rmdirSync(ownerDir);
  }
  return moved;
}

// Hashes in 64 KiB reads so a large file never sits in memory whole. A file
// is read only while the directory total stays inside the bound: one that is
// larger than what is left, or that grows past it while it is being read, is
// reported as oversize without a hash, so a crafted or runaway file costs one
// bound's worth of reading, never its own size. The content is kept (for
// restoring and for saving) only while the kept total stays inside the bound.
function readEntry(full, stat, budget) {
  const mode = stat.mode & 0o777;
  const left = MAX_DIR_BYTES - budget.read;
  if (stat.size > left) return { bytes: stat.size, sha256: null, mode, oversize: true };
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const keep = budget.kept + stat.size <= MAX_DIR_BYTES;
    const hash = crypto.createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > left) {
        budget.read = MAX_DIR_BYTES;
        return { bytes: stat.size, sha256: null, mode, oversize: true };
      }
      hash.update(buffer.subarray(0, read));
      if (keep) chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    budget.read += bytes;
    const entry = { bytes, sha256: hash.digest('hex'), mode };
    if (keep) {
      entry.content = Buffer.concat(chunks);
      budget.kept += bytes;
    }
    return entry;
  } finally {
    fs.closeSync(fd);
  }
}

// Map of relative path (forward slashes) to {bytes, sha256, mode, content}.
// Regular files only: a symlink, a FIFO or a device is not part of the memory.
// At most MAX_ENTRIES files are listed; past that the map carries `truncated`.
function snapshot(dir) {
  const out = new Map();
  const budget = { read: 0, kept: 0 };
  const walk = (current, prefix, depth) => {
    for (const name of readDirOrEmpty(current)) {
      if (out.size >= MAX_ENTRIES) {
        Object.defineProperty(out, 'truncated', { value: true });
        return;
      }
      const full = path.join(current, name);
      const stat = lstatOrNull(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, `${prefix}${name}/`, depth + 1);
      } else if (stat.isFile()) {
        out.set(`${prefix}${name}`, readEntry(full, stat, budget));
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

// What a snapshot breaks, one sentence each; empty when it is safe to save.
// enforce() makes a directory pass this, but a process the agent started can
// outlive the run and change a file after enforce looked, so the save judges
// the snapshot it is about to write, not the directory.
function check(snap) {
  const problems = [];
  if (snap.truncated) problems.push(`it holds more than ${MAX_ENTRIES} files`);
  let total = 0;
  let scripts = 0;
  for (const [rel, entry] of snap) {
    if (entry.oversize) problems.push(`${rel} is larger than the memory directory's ${MAX_DIR_BYTES} byte limit allows`);
    if (!entry.oversize && !Buffer.isBuffer(entry.content)) problems.push(`${rel} has no content to save`);
    total += entry.bytes;
    if (rel === NOTES) {
      if (entry.bytes > MAX_NOTES_BYTES) problems.push(`${NOTES} is ${entry.bytes} bytes, over the ${MAX_NOTES_BYTES} byte limit`);
    } else if (rel.startsWith(`${SCRIPTS}/`) && !rel.slice(SCRIPTS.length + 1).includes('/') && validName(rel.slice(SCRIPTS.length + 1))) {
      scripts += 1;
    } else {
      problems.push(`${rel} is not ${NOTES} or a script`);
    }
  }
  if (scripts > MAX_SCRIPTS) problems.push(`it holds ${scripts} scripts, over the ${MAX_SCRIPTS} limit`);
  if (total > MAX_DIR_BYTES) problems.push(`it holds ${total} bytes, over the ${MAX_DIR_BYTES} byte limit`);
  return problems;
}

// The id git gives a file's content, so a staged blob can be compared with a
// memory file without reading either through git.
function blobSha(content) {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function hashFile(full) {
  const stat = fs.lstatSync(full);
  return readEntry(full, stat, { read: 0, kept: MAX_DIR_BYTES }).sha256;
}

// Applies the bounds to a memory directory the agent has just worked in.
// `previous` is the snapshot taken before the run. Returns the paths that
// passed untouched, the ones put back to their previous content, the ones
// removed, and one sentence per cut for the report.
function enforce(dir, previous = new Map()) {
  const result = { kept: [], restored: [], removed: [], notes: [] };
  if (!isRealDirectory(dir)) return result;
  const restored = new Set();
  const removed = new Set();

  const abs = (rel) => path.join(dir, ...rel.split('/'));

  function remove(rel, reason) {
    fs.rmSync(abs(rel), { recursive: true, force: true });
    restored.delete(rel);
    removed.add(rel);
    result.notes.push(`${rel} was removed: ${reason}`);
  }

  function putBack(rel) {
    const before = previous.get(rel);
    if (!before || !before.content) return false;
    fs.rmSync(abs(rel), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), before.content, { mode: before.mode & 0o777 });
    fs.chmodSync(abs(rel), before.mode & 0o777);
    removed.delete(rel);
    restored.add(rel);
    return true;
  }

  function revert(rel, reason) {
    if (putBack(rel)) {
      result.notes.push(`${rel} kept its previous version: ${reason}`);
    } else {
      remove(rel, reason);
    }
  }

  for (const name of readDirOrEmpty(dir)) {
    if (name !== NOTES && name !== SCRIPTS) {
      remove(name, `only ${NOTES} and ${SCRIPTS}/ are kept`);
    }
  }

  const notes = lstatOrNull(abs(NOTES));
  if (notes) {
    if (!notes.isFile()) {
      revert(NOTES, 'it was not a regular file');
    } else if (notes.size > MAX_NOTES_BYTES) {
      revert(NOTES, `it was ${notes.size} bytes, over the ${MAX_NOTES_BYTES} byte limit`);
    }
  }

  const scripts = lstatOrNull(abs(SCRIPTS));
  if (scripts && !scripts.isDirectory()) {
    remove(SCRIPTS, 'it was not a directory');
    for (const rel of previous.keys()) {
      if (rel.startsWith(`${SCRIPTS}/`) && validName(rel.slice(SCRIPTS.length + 1))) {
        if (putBack(rel)) result.notes.push(`${rel} kept its previous version: ${SCRIPTS} was not a directory`);
      }
    }
  } else if (scripts) {
    const valid = [];
    for (const name of readDirOrEmpty(abs(SCRIPTS))) {
      const rel = `${SCRIPTS}/${name}`;
      if (!validName(name)) {
        remove(rel, 'its name is outside A-Z a-z 0-9 . _ - or longer than 100 characters');
        continue;
      }
      const stat = lstatOrNull(abs(rel));
      if (!stat) continue;
      if (!stat.isFile()) {
        revert(rel, 'it was not a regular file');
        continue;
      }
      valid.push(rel);
    }
    // Scripts the previous run left win the fifty places, so the cut falls on
    // the ones this run added.
    const ordered = [
      ...valid.filter((rel) => previous.has(rel)),
      ...valid.filter((rel) => !previous.has(rel)),
    ];
    for (const rel of ordered.slice(MAX_SCRIPTS)) {
      remove(rel, `a memory directory keeps at most ${MAX_SCRIPTS} scripts`);
    }
  }

  const present = () => {
    const files = [];
    const note = lstatOrNull(abs(NOTES));
    if (note && note.isFile()) files.push({ rel: NOTES, bytes: note.size });
    for (const name of readDirOrEmpty(abs(SCRIPTS))) {
      const stat = lstatOrNull(abs(`${SCRIPTS}/${name}`));
      if (stat && stat.isFile()) files.push({ rel: `${SCRIPTS}/${name}`, bytes: stat.size });
    }
    return files;
  };
  const byLargest = (a, b) => b.bytes - a.bytes || (a.rel < b.rel ? -1 : 1);

  for (;;) {
    const files = present();
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total <= MAX_DIR_BYTES) break;
    const reason = `a memory directory keeps at most ${MAX_DIR_BYTES} bytes`;
    const changed = files
      .filter((file) => {
        const before = previous.get(file.rel);
        return !before || before.bytes !== file.bytes || before.sha256 !== hashFile(abs(file.rel));
      })
      .sort(byLargest);
    if (changed.length > 0) {
      revert(changed[0].rel, reason);
      continue;
    }
    const victim = files.filter((file) => file.rel !== NOTES).sort(byLargest)[0];
    if (!victim) break;
    remove(victim.rel, reason);
  }

  for (const file of present()) {
    if (!restored.has(file.rel)) result.kept.push(file.rel);
  }
  result.restored = [...restored].sort();
  result.removed = [...removed].sort();
  result.kept.sort();
  return result;
}

// What a run did to its memory, for the report. `rootPrefix` is the memory
// directory's place under /workspace/memory (acme/api, or _estate). A removed
// file reports the size it had. Sorted by path, at most 50, and a path longer
// than the contract's 300 characters is left out rather than cut.
function changes(before, after, rootPrefix) {
  const prefix = rootPrefix ? `${String(rootPrefix).replace(/\/+$/, '')}/` : '';
  const listed = [];
  for (const [rel, now] of after) {
    const was = before.get(rel);
    if (!was) listed.push({ path: `${prefix}${rel}`, change: 'added', bytes: now.bytes });
    else if (was.sha256 !== now.sha256) listed.push({ path: `${prefix}${rel}`, change: 'modified', bytes: now.bytes });
  }
  for (const [rel, was] of before) {
    if (!after.has(rel)) listed.push({ path: `${prefix}${rel}`, change: 'removed', bytes: was.bytes });
  }
  return listed
    .filter((entry) => entry.path.length <= MAX_PATH_CHARS)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_CHANGES);
}

// A crash between the two renames that swap a memory directory in leaves
// `<name>.old-<pid>` with no `<name>`, and a crash while one is being built
// leaves `<name>.new-<pid>`. Called before the first poll: a lone .old is put
// back, every other leftover is removed. Returns one sentence per action.
function recover(workspace) {
  const notes = [];
  const { memory: root } = layout(workspace);
  const parents = [root];
  for (const name of readDirOrEmpty(root)) {
    if (isRealDirectory(path.join(root, name))) parents.push(path.join(root, name));
  }
  for (const parent of parents) {
    for (const name of readDirOrEmpty(parent)) {
      const match = /^(.+)\.sre-agent-(new|old)-\d+$/.exec(name);
      if (!match) continue;
      const leftover = path.join(parent, name);
      const live = path.join(parent, match[1]);
      if (match[2] === 'old' && !lstatOrNull(live) && isRealDirectory(leftover)) {
        fs.renameSync(leftover, live);
        notes.push(`${path.relative(root, live)} was put back from ${name}, left aside by a run that stopped while saving it`);
      } else {
        fs.rmSync(leftover, { recursive: true, force: true });
        notes.push(`${path.relative(root, leftover)} was removed, left by a run that stopped while saving`);
      }
    }
  }
  return notes;
}

module.exports = {
  NOTES,
  SCRIPTS,
  ESTATE,
  MAX_NOTES_BYTES,
  MAX_SCRIPTS,
  MAX_DIR_BYTES,
  MAX_CHANGES,
  RESERVED,
  validName,
  layout,
  memoryDir,
  migrate,
  snapshot,
  enforce,
  changes,
  check,
  blobSha,
  recover,
};
