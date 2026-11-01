import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../src/pipe.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pipe-browser.mjs", import.meta.url));
const harness = fileURLToPath(new URL("./fixtures/pipe-leak-harness.mjs", import.meta.url));
const groupHarness = fileURLToPath(new URL("./fixtures/pipe-group-harness.mjs", import.meta.url));

const ALLOCATOR_LINE =
  "Trying to load the allocator multiple times. This is *not* supported.";

test("pipe target creation rejects the global-registry symbol", async () => {
  const client = new PipeCdpClient({ browserPath: process.execPath });
  await assert.rejects(client.send("Target.createTarget", { url: "about:blank" }, undefined, { capability: Symbol.for("omowright.targetCreationCapability") }), /reserved/);
});

test("pipe transport does not leak browser stdout/stderr to the parent tty", async () => {
  const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, `harness failed:\n${stderr}`);
  assert.match(stdout, /HARNESS_OK FakeChrome\/1\.0/);
  assert.ok(!stderr.includes(ALLOCATOR_LINE), `browser stderr leaked to parent:\n${stderr}`);
  assert.ok(!stdout.includes("fake-browser stdout noise"), `browser stdout leaked to parent:\n${stdout}`);
});

test("readiness failure surfaces the drained browser stdio tail", { timeout: 15_000 }, async () => {
  const client = new PipeCdpClient({
    browserPath: process.execPath,
    browserArgs: [fixture],
    spawnOptions: { env: { ...process.env, FAKE_BROWSER_MODE: "mute-cdp" } },
    readinessTimeoutMs: 1500,
  });
  try {
    await assert.rejects(client.ensureConnected(), (err) => {
      assert.match(err.message, /did not become ready over the CDP pipe/);
      assert.match(err.message, /BOOM diagnostics 123/);
      return true;
    });
  } finally {
    await client.close();
  }
});

// --- Browser lifecycle: Chrome must get a graceful quit before any SIGKILL. ---
// Chrome deletes its per-launch macOS code-sign clone and temp profile only on a
// clean exit, so a SIGKILL that skips the quit leaks both (omo#12067). These
// tests use the fake browser above and never need a real Chrome.

const TERM_GRACE_MS = 5_000;

function scratchDir() {
  return mkdtempSync(path.join(os.tmpdir(), "omowright-lifecycle-"));
}

function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [event, at] = line.split(" ");
    return { event, at: Number(at) };
  });
}

function lifecycleClient(dir, onTerm, extraArgs = []) {
  const logPath = path.join(dir, "signals.log");
  const client = new PipeCdpClient({
    browserPath: process.execPath,
    browserArgs: [fixture, ...extraArgs],
    spawnOptions: { env: { ...process.env, FAKE_SIGNAL_LOG: logPath, FAKE_ON_TERM: onTerm } },
  });
  return { client, logPath };
}

function waitFor(predicate, timeoutMs) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() > deadline) return reject(new Error("condition not reached"));
    setTimeout(tick, 25);
  };
  tick();
  return promise;
}

test("close() sends SIGTERM and waits the grace window before SIGKILL", { timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "ignore");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
    await client.close();
    const { signal, at } = await exit;
    const term = readEvents(logPath).find((entry) => entry.event === "TERM");
    assert.ok(term, "browser never received SIGTERM before being killed");
    assert.equal(signal, "SIGKILL");
    assert.ok(at - term.at >= TERM_GRACE_MS - 500, `SIGKILL came ${at - term.at} ms after SIGTERM; expected a ~${TERM_GRACE_MS} ms grace`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() lets a browser that honours SIGTERM quit cleanly, with no SIGKILL", { timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "exit");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await client.close();
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.ok(readEvents(logPath).some((entry) => entry.event === "TERM"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SIGKILL to the caller's process group leaves the browser to quit on pipe EOF", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const logPath = path.join(dir, "signals.log");
  const caller = spawn(process.execPath, [groupHarness, fixture], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FAKE_SIGNAL_LOG: logPath },
  });
  try {
    caller.stdout.setEncoding("utf8");
    let out = "";
    await new Promise((resolve, reject) => {
      caller.stdout.on("data", (chunk) => { out += chunk; if (out.includes("\n")) resolve(); });
      caller.once("exit", () => reject(new Error(`harness exited early: ${out}`)));
    });
    assert.match(out, /^BROWSER_PID \d+/);
    process.kill(-caller.pid, "SIGKILL");
    await waitFor(() => readEvents(logPath).some((entry) => entry.event === "EOF"), 5_000)
      .catch(() => assert.fail("browser died with its caller's process group instead of quitting on pipe EOF"));
  } finally {
    try { process.kill(-caller.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the browser's pidfile lives in its profile and reaps an orphan from a dead caller", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const dir = scratchDir();
  const profile = path.join(dir, "profile");
  mkdirSync(profile);
  const pidFile = path.join(profile, "omowright-browser.pid");
  const first = lifecycleClient(dir, "ignore", [`--user-data-dir=${profile}`]);
  try {
    await first.client.ensureConnected();
    const orphan = first.client.childProcess;
    const recorded = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(recorded.pid, orphan.pid);
    assert.equal(recorded.profileDir, profile);
    // The caller dies without close(): its browser is now an orphan holding the profile.
    orphan.unref();
    const orphanExit = new Promise((resolve) => orphan.once("exit", (code, signal) => resolve({ signal, at: Date.now() })));

    const second = lifecycleClient(dir, "exit", [`--user-data-dir=${profile}`]);
    await second.client.ensureConnected();
    const term = readEvents(first.logPath).find((entry) => entry.event === "TERM");
    assert.ok(term, "orphaned browser was not sent SIGTERM before being reaped");
    const { at } = await orphanExit;
    assert.ok(at - term.at >= TERM_GRACE_MS - 500, "orphan was SIGKILLed without a grace window");
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, second.client.childProcess.pid);
    await second.client.close();
    assert.equal(existsSync(pidFile), false, "pidfile survived a clean close");
  } finally {
    await first.client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
