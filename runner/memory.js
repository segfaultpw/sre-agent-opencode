'use strict';
// The runner's persistent workspace and the memory the agent keeps in it.
//
//   <workspace>/repos/<owner>/<repo>/      clones, reused between requests
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
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Top-level names the runner owns. An old clone under an owner called one of
// these cannot be told from the runner's own directory, so it is not migrated
// and is cloned again under repos/.
const RESERVED = new Set(['repos', 'memory', 'scratch']);

function validName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name) && !/^\.+$/.test(name);
}

function layout(workspace) {
  const base = path.resolve(workspace);
  return {
    repos: path.join(base, 'repos'),
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
    if (RESERVED.has(owner)) continue;
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

// Hashes in 64 KiB reads so a large file never sits in memory whole. The
// content is kept (for restoring) only while the kept total stays inside the
// per-directory bound, which is also the most a restore could ever need.
function readEntry(full, stat, retained) {
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const keep = stat.size <= MAX_DIR_BYTES && retained.total + stat.size <= MAX_DIR_BYTES;
    const hash = crypto.createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
      if (keep) chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    const entry = { bytes, sha256: hash.digest('hex'), mode: stat.mode & 0o777 };
    if (keep) {
      entry.content = Buffer.concat(chunks);
      retained.total += bytes;
    }
    return entry;
  } finally {
    fs.closeSync(fd);
  }
}

// Map of relative path (forward slashes) to {bytes, sha256, mode, content}.
// Regular files only: a symlink, a FIFO or a device is not part of the memory.
function snapshot(dir) {
  const out = new Map();
  const retained = { total: 0 };
  const walk = (current, prefix, depth) => {
    for (const name of readDirOrEmpty(current)) {
      const full = path.join(current, name);
      const stat = lstatOrNull(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, `${prefix}${name}/`, depth + 1);
      } else if (stat.isFile()) {
        out.set(`${prefix}${name}`, readEntry(full, stat, retained));
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

function hashFile(full) {
  const stat = fs.lstatSync(full);
  return readEntry(full, stat, { total: MAX_DIR_BYTES }).sha256;
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

module.exports = {
  NOTES,
  SCRIPTS,
  ESTATE,
  MAX_NOTES_BYTES,
  MAX_SCRIPTS,
  MAX_DIR_BYTES,
  MAX_CHANGES,
  validName,
  layout,
  memoryDir,
  migrate,
  snapshot,
  enforce,
  changes,
};
