import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as omowright from "../src/index.js";

const fakePipeBrowser = fileURLToPath(
  new URL("./fixtures/fake-pipe-browser.mjs", import.meta.url),
);

test("resolveCloakProfile creates and reuses a fixed fingerprint seed", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    const first = await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });
    const second = await omowright.resolveCloakProfile({ profileDir });

    assert.equal(first.fingerprintSeed, 31415);
    assert.deepEqual(second, first);
    assert.deepEqual(first.browserArgs, [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      `--user-data-dir=${profileDir}`,
      "--fingerprint=31415",
      // CloakBrowser ships macOS and Windows fingerprints; every non-macOS host presents as Windows.
      `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
    ]);

    const metadataPath = path.join(profileDir, ".omowright-cloak.json");
    assert.equal(JSON.parse(readFileSync(metadataPath, "utf8")).fingerprintSeed, 31415);
    assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("resolveCloakProfile rejects an explicit seed that changes identity", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });

    await assert.rejects(
      omowright.resolveCloakProfile({ profileDir, fingerprintSeed: 27182 }),
      /fingerprint seed mismatch/i,
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("buildCloakBrowserArgs rejects every identity override form", () => {
  for (const extraArgs of [
    ["--fingerprint=27182"],
    ["--fingerprint", "27182"],
    ["--fingerprint-platform=windows"],
    ["--user-data-dir=/tmp/other-profile"],
    ["--user-data-dir", "/tmp/other-profile"],
  ]) {
    assert.throws(
      () => omowright.buildCloakBrowserArgs({
        profileDir: "/tmp/profile",
        fingerprintSeed: 31415,
        extraArgs,
      }),
      /override fixed profile identity/i,
    );
  }
});

test("resolveCloakProfile tightens existing metadata permissions", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));
  const metadataPath = path.join(profileDir, ".omowright-cloak.json");

  try {
    writeFileSync(metadataPath, '{"fingerprintSeed":31415}\n', { mode: 0o644 });
    chmodSync(metadataPath, 0o644);

    await omowright.resolveCloakProfile({ profileDir });

    assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

// Contract owner: the anonymous (name-less) connectCloakProfile path never
// touches the named-instance registry (IS-5). The child re-imports src/index.js
// with HOME inside the temp dir so even the default registry root derivation is
// observable; if the anonymous path ever delegated to connectNamed, that child
// would create the registry directories and both assertions below would fail.
// The fake CloakBrowser is a shebang wrapper around the shared pipe fixture:
// connectCloakProfile always puts its identity flags before extraArgs, so the
// spawned browserPath itself must be the script and treat those flags as argv.
test("anonymous connectCloakProfile creates no registry artifacts", { timeout: 15_000 }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-anon-"));
  const profileDir = path.join(homeDir, "cloak-profile");
  const registryRoot = path.join(homeDir, "instances-registry");
  const defaultRegistryRoot = path.join(
    homeDir,
    ".local",
    "share",
    "omowright",
    "instances",
  );
  const fakeBrowserPath = path.join(homeDir, "fake-cloak-browser");
  writeFileSync(
    fakeBrowserPath,
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fakePipeBrowser).href)});\n`,
  );
  chmodSync(fakeBrowserPath, 0o755);
  const entryPoint = pathToFileURL(
    fileURLToPath(new URL("../src/index.js", import.meta.url)),
  ).href;
  const childPath = path.join(homeDir, "anon-child.mjs");
  writeFileSync(
    childPath,
    [
      `const { connectCloakProfile } = await import(${JSON.stringify(entryPoint)});`,
      `try {`,
      `  const browser = await connectCloakProfile({`,
      `    browserPath: ${JSON.stringify(fakeBrowserPath)},`,
      `    profileDir: ${JSON.stringify(profileDir)},`,
      `    fingerprintSeed: 31415,`,
      `    registryRoot: ${JSON.stringify(registryRoot)},`,
      `  });`,
      `  await browser.close();`,
      `  process.stdout.write("ANON_CONNECT_OK\\n");`,
      `  process.exit(0);`,
      `} catch (error) {`,
      `  console.error(error);`,
      `  process.exit(1);`,
      `}`,
      "",
    ].join("\n"),
  );

  try {
    // Own process group so a wedged child tree can always be reaped without
    // hanging the test runner waiting for held stdio pipes.
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const stallGuard = setTimeout(killGroup, 12_000);
    let code;
    try {
      code = await new Promise((resolve) => child.once("close", resolve));
    } finally {
      clearTimeout(stallGuard);
      killGroup();
    }

    assert.equal(code, 0, `anonymous connect child failed:\n${stderr}`);
    assert.match(stdout, /ANON_CONNECT_OK/);
    // The connect really ran: the profile seed metadata was written.
    assert.equal(
      existsSync(path.join(profileDir, ".omowright-cloak.json")),
      true,
    );
    // No registry artifacts anywhere: neither the caller-supplied root nor the
    // default ~/.local/share/omowright/instances under the temp HOME exists.
    assert.equal(existsSync(registryRoot), false);
    assert.equal(existsSync(defaultRegistryRoot), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
