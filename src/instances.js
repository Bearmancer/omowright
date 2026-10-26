import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "./connection.js";

const RECORD_VERSION = 2;
const DEFAULT_REGISTRY_ROOT = path.join(
  os.homedir(),
  ".local",
  "share",
  "omowright",
  "instances",
);
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// Waiting for the lock has to outlast the slowest honest critical section
// (probe + launch + CDP attach); a shorter budget makes a second caller give up
// at the exact moment the first one is about to publish its record.
const LOCK_TIMEOUT_MARGIN_MS = 5_000;
// Same sum the per-call resolver below computes, for callers with no overrides.
const DEFAULT_LOCK_TIMEOUT_MS = resolveLockTimeoutMs({});
// A lock whose content never became readable counts as held until it is older
// than any legitimate hold: an unreadable lock is far more likely to be a
// contender caught mid-acquire than an abandoned file.
const STALE_LOCK_GRACE_MS = DEFAULT_LOCK_TIMEOUT_MS;
const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_RETRY_JITTER_MS = 25;
const localLocks = new Map();

function normalizeName(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new TypeError(
      "instance name must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function registryPaths(registryRoot, name) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  return {
    root,
    recordPath: path.join(root, `${name}.json`),
    lockPath: path.join(root, `${name}.lock`),
  };
}

async function ensureRegistryRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
}

function isRecord(value, expectedName) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === RECORD_VERSION &&
    value.name === expectedName &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.endpoint === "string" &&
    value.endpoint.length > 0 &&
    typeof value.webSocketDebuggerUrl === "string" &&
    value.webSocketDebuggerUrl.length > 0 &&
    (typeof value.profileDir === "string" || value.profileDir === null) &&
    typeof value.browserPath === "string" &&
    value.browserPath.length > 0 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt))
  );
}

async function readRecord(recordPath, expectedName) {
  let text;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, record: null };
    throw error;
  }

  try {
    const record = JSON.parse(text);
    return {
      exists: true,
      record: isRecord(record, expectedName) ? record : null,
    };
  } catch {
    return { exists: true, record: null };
  }
}

async function writeRecordAtomic(root, recordPath, record) {
  const tempPath = path.join(
    root,
    `.${record.name}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, recordPath);
    await chmod(recordPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function unlinkIfPresent(target) {
  await unlink(target).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

// Build the lock out of sight and hard-link it into place, so a lock file is
// never visible half-written: a reader either misses it or reads it whole.
// Returns the inode that identifies our lock, or null when the path is taken.
async function createLock(lockPath) {
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
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
    return ino;
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
    let pid = null;
    try {
      const value = JSON.parse(text);
      if (Number.isInteger(value?.pid) && value.pid > 0) pid = value.pid;
    } catch {
      // No identity: an empty or partial lock is aged out, never reclaimed on
      // the spot, because a live contender may have just created it.
    }
    return { ino: stats.ino, mtimeMs: stats.mtimeMs, pid };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Remove a lock proven abandoned without ever removing one that is not. The
// rename is the exclusive step: of two reclaimers only one moves a given
// directory entry. Whatever we moved is then ours alone to inspect, so the
// inode check is exact; a lock we had not proven dead goes straight back.
async function reclaimLock(lockPath, ino) {
  try {
    if ((await stat(lockPath)).ino !== ino) return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }

  const movedPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, movedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  try {
    // Only a verified inode match is dropped by the cleanup below; anything we
    // cannot prove dead — a fresh lock, or a file we failed to stat — goes back
    // under the name its owner expects.
    const moved = await stat(movedPath).catch(() => null);
    if (moved?.ino === ino) return true;
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
async function releaseLock(lockPath, ino) {
  try {
    if ((await stat(lockPath)).ino !== ino) return;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
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

async function acquireLock(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let holderPid = null;
  for (;;) {
    const ino = await createLock(lockPath);
    if (ino !== null) return () => releaseLock(lockPath, ino);
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for instance lock held by pid ${holderPid ?? "unknown"}`,
      );
    }

    const state = await readLockState(lockPath);
    if (state === null) continue;
    holderPid = state.pid ?? holderPid;
    const abandoned =
      state.pid === null
        ? Date.now() - state.mtimeMs >= STALE_LOCK_GRACE_MS
        : !isPidAlive(state.pid);
    if (abandoned) {
      await reclaimLock(lockPath, state.ino);
      // Jitter keeps two reclaimers from retrying in lockstep forever.
      await sleep(Math.random() * LOCK_RETRY_JITTER_MS);
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await waitForLockRelease(
        lockPath,
        Math.min(remainingMs, LOCK_POLL_INTERVAL_MS),
      );
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

function isConnectionRefused(error) {
  for (let cause = error; cause; cause = cause?.cause) {
    if (
      cause.code === "ECONNREFUSED" ||
      cause.code === "ENOTFOUND" ||
      // Bun's fetch reports refused connections with this code.
      cause.code === "ConnectionRefused"
    ) {
      return true;
    }
  }
  return false;
}

async function probeEndpoint(endpoint, timeoutMs) {
  const versionUrl = new URL("/json/version", endpoint);
  const response = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `CDP discovery request failed (${response.status} ${response.statusText})`,
    );
  }
  const version = await response.json();
  if (
    typeof version?.webSocketDebuggerUrl !== "string" ||
    version.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error("CDP discovery response lacks webSocketDebuggerUrl");
  }
  return version;
}

function resolveConnectTimeoutMs(options) {
  return options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
}

function resolveLockTimeoutMs(options) {
  if (options.lockTimeoutMs !== undefined) return options.lockTimeoutMs;
  return (
    (options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS) +
    (options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS) +
    resolveConnectTimeoutMs(options) +
    LOCK_TIMEOUT_MARGIN_MS
  );
}

// `/json/version` answering proves nothing about the WebSocket upgrade behind
// it, so the session handshake carries its own bound.
async function connectWithin(endpoint, options, timeoutMs) {
  const pending = connect(endpoint, options);
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${timeoutMs}ms opening a CDP session on ${endpoint}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // A session that lands after the bound would otherwise hold a live socket.
    pending.then(
      (connection) => connection.close().catch(() => {}),
      () => {},
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedRecord(recordPath, name, pid) {
  const loaded = await readRecord(recordPath, name);
  if (loaded.record?.pid !== pid) return;
  await unlinkIfPresent(recordPath);
}

function profileDirFromArgs(browserArgs) {
  for (let index = 0; index < browserArgs.length; index += 1) {
    const argument = browserArgs[index];
    if (argument === "--user-data-dir" && browserArgs[index + 1]) {
      return path.resolve(browserArgs[index + 1]);
    }
    if (argument.startsWith("--user-data-dir=")) {
      return path.resolve(argument.slice("--user-data-dir=".length));
    }
  }
  return null;
}

function httpEndpointFromWebSocket(webSocketUrl) {
  const endpoint = new URL(webSocketUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function parseActivePort(text) {
  const [portLine] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
}

async function terminateBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let forceTimer;
  const force = new Promise((resolve) => {
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
  });
  await Promise.race([exited, force]);
  clearTimeout(forceTimer);
  if (child.exitCode === null && child.signalCode === null) await exited;
}

async function discoverLaunchedEndpoint(
  child,
  { profileDir, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS } = {},
) {
  const activePortPath = profileDir
    ? path.join(profileDir, "DevToolsActivePort")
    : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let activePortWatcher;
    let activePortRead = false;
    const cleanups = [];

    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      activePortWatcher?.close();
      if (error) reject(error);
      else resolve(endpoint);
    };

    const tryActivePort = async () => {
      if (!activePortPath || activePortRead || settled) return;
      activePortRead = true;
      try {
        const endpoint = parseActivePort(
          await readFile(activePortPath, "utf8"),
        );
        if (endpoint) finish(null, endpoint);
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      } finally {
        activePortRead = false;
      }
    };

    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) finish(null, httpEndpointFromWebSocket(match[1]));
      else void tryActivePort();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      finish(
        new Error(
          `browser exited before exposing DevTools (code ${code}, signal ${signal ?? "none"})${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    cleanups.push(() => child.stderr.off("data", onStderr));
    cleanups.push(() => child.off("error", onError));
    cleanups.push(() => child.off("exit", onExit));

    if (activePortPath) {
      try {
        activePortWatcher = watch(profileDir, (event, filename) => {
          if (
            (event === "rename" || event === "change") &&
            (!filename ||
              filename.toString() === path.basename(activePortPath))
          ) {
            void tryActivePort();
          }
        });
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      }
      void tryActivePort();
    }

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `browser did not expose a DevTools endpoint within ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeout));
  });
}

function connectionOptions(options, profileDir) {
  const result = { ...(options.connectionOptions ?? {}) };
  if (options.storageRoot !== undefined) result.storageRoot = options.storageRoot;
  else if (result.storageRoot === undefined && profileDir) {
    result.storageRoot = profileDir;
  }
  if (options.client !== undefined) {
    result.client = {
      ...(result.client ?? {}),
      ...options.client,
    };
  }
  return result;
}

async function launchNamed(
  name,
  { root, recordPath },
  options,
) {
  if (typeof options.browserPath !== "string" || options.browserPath.length === 0) {
    throw new TypeError(
      `connectNamed("${name}") requires browserPath when no healthy instance is registered`,
    );
  }
  const browserArgs = [...(options.browserArgs ?? [])];
  const profileDir = options.profileDir
    ? path.resolve(options.profileDir)
    : profileDirFromArgs(browserArgs);
  const child = spawn(
    options.browserPath,
    [
      ...browserArgs,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    {
      ...(options.spawnOptions ?? {}),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let connection;
  try {
    const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const endpoint = await discoverLaunchedEndpoint(child, {
      profileDir,
      timeoutMs: launchTimeoutMs,
    });
    // The browser's own WebSocket URL carries its GUID: recording it makes a
    // later attach prove it reached this browser and not whatever else ends up
    // on the port once this pid is gone.
    const { webSocketDebuggerUrl } = await probeEndpoint(
      endpoint,
      launchTimeoutMs,
    );
    connection = await connectWithin(
      endpoint,
      connectionOptions(options, profileDir),
      resolveConnectTimeoutMs(options),
    );
    const record = {
      version: RECORD_VERSION,
      name,
      pid: child.pid,
      endpoint,
      webSocketDebuggerUrl,
      profileDir,
      browserPath: path.resolve(options.browserPath),
      startedAt: new Date().toISOString(),
    };
    await writeRecordAtomic(root, recordPath, record);
    connection.browserProcess = child;
    const disconnect = connection.close.bind(connection);
    connection.close = async () => {
      let failure;
      try {
        await disconnect();
      } catch (error) {
        failure = error;
      }
      await terminateBrowser(child);
      // The browser this record points at is gone, so the record goes with it
      // instead of waiting for the next caller to clean it up.
      try {
        await removeOwnedRecord(recordPath, name, child.pid);
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    };
    return connection;
  } catch (error) {
    await connection?.close().catch(() => {});
    await terminateBrowser(child);
    throw error;
  }
}

export async function withEngineLock(registryRoot, engineKey, run) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const digest = createHash("sha256")
    .update(path.resolve(engineKey))
    .digest("hex")
    .slice(0, 16);
  const lockPath = path.join(root, `_engine-${digest}.lock`);
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const release = await acquireLock(lockPath, DEFAULT_LOCK_TIMEOUT_MS);
    try {
      return await run();
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}

export async function connectNamed(name, options = {}) {
  const normalizedName = normalizeName(name);
  const paths = registryPaths(options.registryRoot, normalizedName);
  await ensureRegistryRoot(paths.root);
  const releaseLocal = await acquireLocalLock(paths.lockPath);

  try {
    const release = await acquireLock(
      paths.lockPath,
      resolveLockTimeoutMs(options),
    );
    try {
      const loaded = await readRecord(paths.recordPath, normalizedName);
      if (loaded.record) {
        await chmod(paths.recordPath, 0o600);
        if (isPidAlive(loaded.record.pid)) {
          let version = null;
          try {
            version = await probeEndpoint(
              loaded.record.endpoint,
              options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
            );
          } catch (error) {
            if (!isConnectionRefused(error)) {
              throw new Error(
                `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${error.message}`,
                { cause: error },
              );
            }
            // A live pid whose recorded debug port refuses connections is a
            // reused pid, not a holder: the record is stale and the launch
            // below reclaims it.
          }
          // A pid that came back and a port any local process can rebind are
          // not an identity. Only the recorded WebSocket URL (it carries the
          // browser GUID) says this is our browser; anything else answering
          // there is a stranger, so the record is stale, not a holder.
          if (
            version?.webSocketDebuggerUrl === loaded.record.webSocketDebuggerUrl
          ) {
            try {
              return await connectWithin(
                loaded.record.endpoint,
                connectionOptions(options, loaded.record.profileDir),
                resolveConnectTimeoutMs(options),
              );
            } catch (error) {
              throw new Error(
                `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${error.message}`,
                { cause: error },
              );
            }
          }
        }
      }

      if (loaded.exists) {
        await unlink(paths.recordPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      return await launchNamed(normalizedName, paths, options);
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}

export async function listInstances(options = {}) {
  const root = path.resolve(options.registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const expectedName = entry.name.slice(0, -".json".length);
        const recordPath = path.join(root, entry.name);
        const loaded = await readRecord(recordPath, expectedName);
        if (!loaded.record) return null;
        await chmod(recordPath, 0o600);
        const alive = isPidAlive(loaded.record.pid);
        let responsive = false;
        if (alive) {
          responsive = await probeEndpoint(
            loaded.record.endpoint,
            options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          ).then(
            (version) =>
              version.webSocketDebuggerUrl === loaded.record.webSocketDebuggerUrl,
            () => false,
          );
        }
        return { ...loaded.record, alive, responsive };
      }),
  );
  return records
    .filter((record) => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
