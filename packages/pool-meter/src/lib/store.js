'use strict';
// store.js — crash-safe, concurrency-safe JSON file updates.
//
// pool-keys.json is hot-reloaded every 5s AND edited by hand by Shadow. A naive
// read-modify-write from the join flow would silently clobber a concurrent hand
// edit (or lose a freshly minted key). Every mutation therefore goes through
// `update()`, which takes an exclusive lockfile, re-reads the file INSIDE the
// lock, applies the mutation, and commits with fsync + atomic rename.
//
// Node stdlib only.

const fs = require('fs');
const path = require('path');

const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_POLL_MS = 25;

function sleepSync(ms) {
  // Blocking sleep without a dep. Only ever runs while contending for a lock
  // that is held for single-digit milliseconds, so this never meaningfully
  // parks the event loop in practice.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(file) {
  return `${file}.lock`;
}

/** Acquire an exclusive lock for `file`. Returns a release function. */
function acquireLock(file) {
  const lock = lockPath(file);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch (_) {
          /* already released */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Break a lock left behind by a crashed writer, but only once it is
      // provably older than any legitimate critical section.
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch (_) {
        continue; // vanished between open and stat; retry immediately
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lock);
        } catch (_) {
          /* someone else broke it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`store: timed out waiting for lock on ${path.basename(file)}`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function readJsonSync(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return typeof fallback === 'function' ? fallback() : fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : fallback;
    throw err;
  }
}

/**
 * Write `data` to `file` atomically: temp file in the same directory, fsync,
 * then rename. A reader (including pool-meter's own 5s hot reload) therefore
 * only ever observes the complete old file or the complete new one, never a
 * truncated write.
 */
function writeJsonAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/**
 * Exclusive read-modify-write. `mutate(current)` must return the value to
 * persist, or `undefined`/`null` to abort the write. The value it receives is
 * always freshly read from disk inside the lock, so concurrent writers compose
 * instead of clobbering.
 */
function update(file, fallback, mutate, mode = 0o600) {
  const release = acquireLock(file);
  try {
    const current = readJsonSync(file, fallback);
    const result = mutate(current);
    if (result === undefined || result === null) return { written: false, value: current };
    writeJsonAtomic(file, result, mode);
    return { written: true, value: result };
  } finally {
    release();
  }
}

/** Append one JSON object as a line. Used for append-only audit logs. */
function appendJsonl(file, record) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`store: jsonl append failed for ${path.basename(file)}: ${err.message}`);
  }
}

module.exports = { update, readJsonSync, writeJsonAtomic, appendJsonl, acquireLock };
