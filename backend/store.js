'use strict';

/**
 * Crash-safe persistence for the single-file JSON store.
 *
 * Why this exists: `fs.writeFileSync(path, JSON.stringify(db))` truncates the
 * live file first, so a crash / power loss / full disk mid-write leaves an
 * unparseable store — losing the catalogue, the users and the payment ledger.
 *
 * Strategy:
 *   1. serialise to a temp file in the same directory, fsync it;
 *   2. move the current file to `data.json.bak` (atomic rename);
 *   3. move the temp file into place (atomic rename).
 *
 * A reader therefore always sees either the complete old file or the complete
 * new one. On boot we try the live file first, then the backup, so a crash
 * between steps 2 and 3 still recovers the previous good state.
 */

const fs = require('fs');
const path = require('path');

function tempPath(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
}

function backupPath(file) {
  return file + '.bak';
}

function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) throw new Error('empty file');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('store root must be an object');
  }
  return data;
}

/**
 * Loads the store, falling back to the last good backup.
 * Returns { data, source, recovered, error }.
 */
function load(file) {
  let lastError = null;

  try {
    return { data: parseFile(file), source: file, recovered: false, error: null };
  } catch (err) {
    lastError = err;
    if (err.code !== 'ENOENT') {
      // Keep the damaged file around for forensics instead of silently losing it.
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (e) {}
    }
  }

  try {
    const data = parseFile(backupPath(file));
    return { data, source: backupPath(file), recovered: true, error: lastError };
  } catch (err) {
    if (!lastError) lastError = err;
    return { data: null, source: null, recovered: false, error: lastError };
  }
}

/** Atomically replaces `file` with `data`. Returns the serialised byte length. */
function save(file, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = tempPath(file);
  const dir = path.dirname(file);

  fs.mkdirSync(dir, { recursive: true });

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }

  // Rotate the previous good copy. If the live file is missing/corrupt this
  // simply fails and we keep the older backup.
  if (fs.existsSync(file)) {
    try {
      fs.renameSync(file, backupPath(file));
    } catch (err) {
      try { fs.copyFileSync(file, backupPath(file)); } catch (e) {}
    }
  }

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse to replace an existing destination in some states.
    try { fs.rmSync(file, { force: true }); } catch (e) {}
    fs.renameSync(tmp, file);
  }

  return Buffer.byteLength(json, 'utf8');
}

/** Removes stale temp files left behind by a killed process. */
function cleanupTempFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of entries) {
    if (name.startsWith(`.${base}.`) && name.endsWith('.tmp') && !name.includes(`.${process.pid}.tmp`)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1; } catch (e) {}
    }
  }
  return removed;
}

module.exports = { load, save, backupPath, tempPath, cleanupTempFiles };
