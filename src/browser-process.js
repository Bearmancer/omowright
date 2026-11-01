// Lifecycle of a browser the pipe transport spawns. Chrome removes its per-launch
// state (the macOS code-sign clone of the app bundle, a temp profile) only when
// it quits cleanly, so nothing here sends SIGKILL before a SIGTERM and a bounded
// grace window (omo#12067).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isPidAlive } from "./instance-lock.js";
import { processStartTime } from "./lock-file.js";

export const TERM_GRACE_MS = 5_000;
const PID_FILE_NAME = "omowright-browser.pid";
const REAP_POLL_MS = 50;

// Own process group on POSIX: a group-wide SIGKILL of the caller (an eval cell
// settling, `timeout -s KILL`) no longer takes the browser with it; the browser
// instead reads EOF on its CDP pipe and quits on its own. Windows has no process
// groups to escape, and `detached` there would open a console window.
export const browserSpawnDetached = process.platform !== "win32";

export function profileDirFromArgs(browserArgs) {
  for (let index = 0; index < browserArgs.length; index += 1) {
    const argument = browserArgs[index];
    if (argument === "--user-data-dir" && browserArgs[index + 1]) return path.resolve(browserArgs[index + 1]);
    if (argument.startsWith("--user-data-dir=")) return path.resolve(argument.slice("--user-data-dir=".length));
  }
  return null;
}

export async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try { child.kill("SIGTERM"); } catch {}
  let timer;
  const graceOver = new Promise((resolve) => { timer = setTimeout(resolve, TERM_GRACE_MS); });
  await Promise.race([exited, graceOver]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch {}
    await exited;
  }
}

function pidFilePath(profileDir) {
  return path.join(profileDir, PID_FILE_NAME);
}

export async function writeBrowserPidFile(profileDir, pid) {
  if (!profileDir || !pid) return;
  const start = await processStartTime(pid);
  writeFileSync(pidFilePath(profileDir), `${JSON.stringify({ pid, start, profileDir })}\n`, { mode: 0o600 });
}

export function removeBrowserPidFile(profileDir, pid) {
  if (!profileDir) return;
  try {
    const recorded = JSON.parse(readFileSync(pidFilePath(profileDir), "utf8"));
    if (recorded.pid !== pid) return;
  } catch {
    return;
  }
  rmSync(pidFilePath(profileDir), { force: true });
}

// A pidfile left in the profile names a browser whose caller died without
// close(). Give it the same SIGTERM-then-grace treatment before reusing the
// profile. The recorded start time guards against a recycled pid.
export async function reapOrphanedBrowser(profileDir) {
  if (!profileDir) return;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(pidFilePath(profileDir), "utf8"));
  } catch {
    return;
  }
  const { pid, start } = recorded;
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)
    && start !== null && start === await processStartTime(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + TERM_GRACE_MS;
    while (isPidAlive(pid) && Date.now() < deadline) await sleep(REAP_POLL_MS);
    if (isPidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  rmSync(pidFilePath(profileDir), { force: true });
}
