import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { chmod, link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_RETRY_JITTER_MS = 25;
const execFileAsync = promisify(execFile);
const localLocks = new Map();
let ownStartTime;

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

// When the process holding `pid` started, in a form that only has to compare
// equal to itself on this machine; null when the platform cannot say. A dead
// holder's pid can be reused, and pid plus start time is what stays unique.
async function processStartTime(pid) {
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime); the fields after the parenthesised comm start at 3.
      return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Build the lock out of sight and hard-link it into place, so a lock file is
// never visible half-written: a reader either misses it or reads it whole.
// Returns the inode and token that identify our lock, or null when the path is taken.
async function createLock(lockPath) {
  ownStartTime ??= processStartTime(process.pid);
  const token = randomUUID();
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, start: await ownStartTime, token, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    const { ino } = await handle.stat();
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    try {
      await link(tempPath, lockPath);
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      throw error;
    }
    return { ino, token };
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

// Content and inode come from one open handle, so the identity we act on is
// bound to the exact file we inspected rather than to the path.
async function readLockState(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    const text = await handle.readFile("utf8");
    const state = { ino: stats.ino, mtimeMs: stats.mtimeMs, pid: null, start: null, token: null };
    try {
      const value = JSON.parse(text);
      if (Number.isInteger(value?.pid) && value.pid > 0) state.pid = value.pid;
      if (typeof value?.start === "string") state.start = value.start;
      if (typeof value?.token === "string") state.token = value.token;
    } catch {
      // No identity: an empty or partial lock is aged out, never reclaimed on
      // the spot, because a live contender may have just created it.
    }
    return state;
  } finally {
    await handle.close().catch(() => {});
  }
}

function isSameLock(state, ino, token) {
  return state !== null && state.ino === ino && state.token === token;
}

async function isAbandoned(state, staleGraceMs) {
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
// its token differs, and anything that does not match goes straight back.
export async function reclaimLock(lockPath, ino, token) {
  if (!isSameLock(await readLockState(lockPath), ino, token)) {
    return (await stat(lockPath).catch(() => null)) === null;
  }
  const movedPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, movedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  try {
    if (isSameLock(await readLockState(movedPath).catch(() => null), ino, token)) return true;
    await link(movedPath, lockPath).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    return false;
  } finally {
    await unlinkIfPresent(movedPath);
  }
}

// Only unlink the entry while it still names the lock we created: if ours was
// reclaimed under us, the file at this path belongs to the next owner.
async function releaseLock(lockPath, ino, token) {
  if (!isSameLock(await readLockState(lockPath), ino, token)) return;
  await unlinkIfPresent(lockPath);
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

async function acquireLock(lockPath, timeoutMs, staleGraceMs) {
  const deadline = Date.now() + timeoutMs;
  let holderPid = null;
  for (;;) {
    const ours = await createLock(lockPath);
    if (ours !== null) return () => releaseLock(lockPath, ours.ino, ours.token);
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for instance lock held by pid ${holderPid ?? "unknown"}`,
      );
    }

    const state = await readLockState(lockPath);
    if (state === null) continue;
    holderPid = state.pid ?? holderPid;
    if (await isAbandoned(state, staleGraceMs)) {
      await reclaimLock(lockPath, state.ino, state.token);
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
export async function withLock(lockPath, { timeoutMs, staleGraceMs }, run) {
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const release = await acquireLock(lockPath, timeoutMs, staleGraceMs);
    try {
      return await run();
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}
