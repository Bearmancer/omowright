import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { link, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createLock,
  isSameLock,
  processStartTime,
  readLockState,
} from "./lock-file.js";

const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_RETRY_JITTER_MS = 25;
const LOCK_PUT_BACK_TIMEOUT_MS = 30_000;
const RELEASE_SEARCH_ATTEMPTS = 5;
const localLocks = new Map();

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function unlinkIfPresent(target) {
  await unlink(target).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

// A holder marks its lock released by setting the file's mtime to 0, one
// atomic metadata write on the inode. Every link to that inode carries the
// mark, so a copy moved aside or put back after the release is still known
// to be free. No live lock has mtime 0: createLock writes fresh files.
function isReleased(state) {
  return state.mtimeMs === 0;
}

async function isAbandoned(state, staleGraceMs) {
  if (isReleased(state)) return true;
  if (state.pid === null) return Date.now() - state.mtimeMs >= staleGraceMs;
  if (!isPidAlive(state.pid)) return true;
  if (state.start === null) return false;
  const start = await processStartTime(state.pid);
  return start !== null && start !== state.start;
}

// Deletes only the lock that was proved abandoned, identified by inode AND
// token, never another one. The rename is the exclusive step: of two
// reclaimers only one moves a given entry, and whatever we moved is ours alone
// to inspect. An inode number alone is not enough because ext4 reuses them, so
// a live lock created after the dead one vanished can carry the same inode;
// its token differs, and anything that does not match is put back.
// `hooks` lets a test run code inside the gaps between these steps.
export async function reclaimLock(lockPath, ino, token, { deadline = Date.now() + LOCK_PUT_BACK_TIMEOUT_MS, hooks = {} } = {}) {
  if (!isSameLock(await readLockState(lockPath), ino, token)) {
    return (await stat(lockPath).catch(() => null)) === null;
  }
  const movedPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  await hooks.beforeMove?.();
  try {
    await rename(lockPath, movedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  await hooks.afterMove?.();
  if (isSameLock(await readLockState(movedPath).catch(() => null), ino, token)) {
    await unlinkIfPresent(movedPath);
    return true;
  }
  await putBack(movedPath, lockPath, deadline, hooks);
  return false;
}

// The moved file is a live holder's lock. While the name was empty another
// contender may have locked it; the moved lock then waits for that one to go.
// It is never deleted while its holder may still hold it: it leaves only when
// it is back under its name, when its holder released it (the release marks
// the inode and removes moved copies it finds), or it stays where it is past
// the deadline, for the holder's release or a later sweep to remove.
async function putBack(movedPath, lockPath, deadline, hooks) {
  for (;;) {
    const moved = await readLockState(movedPath).catch(() => null);
    if (moved === null) return;
    if (isReleased(moved)) {
      await unlinkIfPresent(movedPath);
      return;
    }
    try {
      await link(movedPath, lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code !== "EEXIST") throw error;
      await hooks.onPutBackBlocked?.();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      await waitForLockRelease(lockPath, Math.min(remainingMs, LOCK_POLL_INTERVAL_MS));
      continue;
    }
    await unlinkIfPresent(movedPath);
    // The holder may have marked it released between our read and the link;
    // a released lock back under the name would block it until it is reclaimed.
    const restored = await readLockState(lockPath);
    if (isReleased(restored ?? {}) && isSameLock(restored, moved.ino, moved.token)) {
      await unlinkIfPresent(lockPath);
    }
    return;
  }
}

function staleCopyPaths(lockPath, entries) {
  const prefix = `${path.basename(lockPath)}.`;
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".stale"))
    .map((entry) => path.join(path.dirname(lockPath), entry));
}

// Where our lock is right now: under its name, or moved aside by a reclaimer.
async function findOwnLock(lockPath, ino, token) {
  if (isSameLock(await readLockState(lockPath), ino, token)) return lockPath;
  const entries = await readdir(path.dirname(lockPath)).catch(() => []);
  for (const copy of staleCopyPaths(lockPath, entries)) {
    if (isSameLock(await readLockState(copy).catch(() => null), ino, token)) return copy;
  }
  return null;
}

// Marks our lock released first, wherever it is, then removes every entry
// that still names it. Once marked, a copy we miss because a reclaimer moves
// or puts it back meanwhile is still free: putBack drops it and isAbandoned
// reclaims it. A rename or link always leaves the inode under some entry, so
// the search below only misses it while a reclaimer is mid-step.
async function releaseLock(lockPath, ino, token, hooks = {}) {
  for (let attempt = 0; attempt < RELEASE_SEARCH_ATTEMPTS; attempt += 1) {
    const found = await findOwnLock(lockPath, ino, token);
    if (found === null) continue;
    try {
      await utimes(found, 0, 0);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await hooks.afterMark?.();
  if (isSameLock(await readLockState(lockPath), ino, token)) await unlinkIfPresent(lockPath);
  await hooks.beforeScan?.();
  const entries = await readdir(path.dirname(lockPath)).catch(() => []);
  for (const copy of staleCopyPaths(lockPath, entries)) {
    if (isSameLock(await readLockState(copy).catch(() => null), ino, token)) {
      await unlinkIfPresent(copy);
    }
  }
}

// Moved copies whose holder is gone (released, dead, or an identity-less
// file past the grace period) are removed. A copy whose holder may still hold
// it stays for its put-back.
async function sweepStaleCopies(lockPath, staleGraceMs) {
  const entries = await readdir(path.dirname(lockPath)).catch(() => []);
  for (const copy of staleCopyPaths(lockPath, entries)) {
    const state = await readLockState(copy).catch(() => null);
    if (state !== null && (await isAbandoned(state, staleGraceMs))) await unlinkIfPresent(copy);
  }
}

function waitForLockRelease(lockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let timer;
    const finish = (error, released) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(released);
    };
    const check = () => {
      stat(lockPath).then(
        () => {},
        (error) => {
          if (error?.code === "ENOENT") finish(null, true);
          else finish(error);
        },
      );
    };
    try {
      watcher = watch(path.dirname(lockPath), (event, filename) => {
        if (
          (event === "rename" || event === "change") &&
          (!filename || filename.toString() === path.basename(lockPath))
        ) {
          check();
        }
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        finish(error);
        return;
      }
    }
    timer = setTimeout(() => finish(null, false), timeoutMs);
    check();
  });
}

async function acquireLock(lockPath, timeoutMs, staleGraceMs, hooks) {
  const deadline = Date.now() + timeoutMs;
  let holderPid = null;
  let swept = false;
  for (;;) {
    const ours = await createLock(lockPath);
    if (ours !== null) return () => releaseLock(lockPath, ours.ino, ours.token, hooks);
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for instance lock held by pid ${holderPid ?? "unknown"}`,
      );
    }

    if (!swept) {
      swept = true;
      await sweepStaleCopies(lockPath, staleGraceMs);
    }
    const state = await readLockState(lockPath);
    if (state === null) continue;
    holderPid = state.pid ?? holderPid;
    if (await isAbandoned(state, staleGraceMs)) {
      // The reclaim may wait, inside our own budget, for a live lock it moved
      // aside to go back; a timeout then names the holder we last read.
      await reclaimLock(lockPath, state.ino, state.token, { deadline });
      // Jitter keeps two reclaimers from retrying in lockstep forever.
      await sleep(Math.random() * LOCK_RETRY_JITTER_MS);
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await waitForLockRelease(lockPath, Math.min(remainingMs, LOCK_POLL_INTERVAL_MS));
    }
  }
}

async function acquireLocalLock(key) {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  localLocks.set(key, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (localLocks.get(key) === tail) localLocks.delete(key);
  };
}

// Runs `run` while this process and every other one agree we hold `lockPath`.
// A lock with no readable identity counts as held until it is `staleGraceMs` old.
// `hooks.afterMark` and `hooks.beforeScan` let a test run code inside the release.
export async function withLock(lockPath, { timeoutMs, staleGraceMs, hooks }, run) {
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const release = await acquireLock(lockPath, timeoutMs, staleGraceMs, hooks);
    try {
      return await run();
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}
