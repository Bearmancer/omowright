import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateShippedSource, findRawTlsClients, isScannedSourceFile } from "./tls-client-detector.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Security contract: CVE-2026-48618 must not gain an unreviewed raw-host path.
// The bundled ws@8.21.3 connector parses new URL(address) before host/SNI;
// OmOWright supplies headers only. See senpi#3078 and oh-my-openagent#9892.
// Entries must pin { file, call: exact normalized text, count, reason }.
// Empty today: dependency bundles are reviewed separately, not file-exempted.
const ALLOWLIST = [];

describe("raw TLS client guard (CVE-2026-48618)", () => {

  it("detects calls independently of their module acquisition pins", () => {
    for (const [sample, call] of [
  [
    "import { default as client } from \"node:https\"; client.request(options);",
    "client.request(options)"
  ],
  [
    "import * as client from \"node:tls\"; client.connect(options);",
    "client.connect(options)"
  ],
  [
    "const client = require(\"node:https\"); client.get(url);",
    "client.get(url)"
  ],
  [
    "const { connect: dial } = await import(`node:tls`); dial(options);",
    "dial(options)"
  ],
  [
    "import client from \"https\"; const request = client.request; request(options);",
    "request(options)"
  ],
  [
    "const { default: client } = await import(\"node:https\"); client.get(url);",
    "client.get(url)"
  ]
]) {
      assert.ok(findRawTlsClients(sample).some(hit => hit.text === call), sample);
    }
  });
  it("does not interpret regex or literal text as calls", () => {
    for (const sample of ['const s = "tls.connect(o)";', 'const s = `tls.connect(o)`;', 'const r = /tls.connect\\(o\\)/;'])
      assert.deepEqual(findRawTlsClients(sample), []);
  });

  it("catches reviewer H1 regex/templates and H2 acquisitions (security regression)", () => {
    for (const sample of [
  "const r = /\"/; tls.connect(o); const s = \"x\";",
  "const r = /`/; tls.connect(o); const s = `x`;",
`const s = \`\${a ? \`"\` : ""}\`; tls.connect(o); const z = "q";`,
  "const r = /a\\/*/; tls.connect(o); /* */",
  "import { default as h } from \"node:https\"; h.request(o);",
  "export { default } from \"node:https\";",
  "export { default as h } from \"node:http2\";",
  "Bun?.connect({ tls: true });",
  "const { connect } = Bun; connect({ tls: true });",
  "const c = Bun.connect; c({ tls: true });",
  "Bun.connect.call(null, { tls: true });",
  "Bun.connect.apply(null, [{ tls: true }]);"
]) assert.ok(findRawTlsClients(sample).length, sample);
  });
  it("fails closed and names malformed shipped source", () => {
    for (const content of ['const s = "unterminated', 'const s = `unterminated', 'function f() {']) {
      assert.throws(() => evaluateShippedSource([{ path: "src/broken.js", content }], []), /src\/broken\.js/);
    }
  });
  it("detects every direct client and module acquisition form", () => {
    const samples = [
      'import { createServer } from "node:https";',
      'export { createSecureServer } from "node:http2";',
      "tls.createSecureContext(options)",
      "tls.connect({ host, port: 443 })",
      "https.request(url, callback)",
      "https.get(url)",
      "http2.connect(authority)",
      "Bun.connect({ hostname, tls: true })",
      "new https.Agent(options)",
      "new tls.TLSSocket(socket, options)",
      "const options = { checkServerIdentity: check }",
      'tls["connect"](options)',
      "Bun[`connect`](options)",
    ];
    for (const module of ["tls", "https", "http2"]) {
      for (const prefix of ["", "node:"]) {
        const name = prefix + module;
        const member = module === "https" ? "request" : "connect";
        samples.push(
          `import client from "${name}";`,
          `import * as client from '${name}';`,
          `import { ${member} as client } from "${name}";`,
          `import client, { ${member} } from "${name}";`,
          `import "${name}";`,
          `const client = require("${name}");`,
          `const client = await import('${name}');`,
          `const client = await import(\`${name}\`);`,
          `const client = require(\`${name}\`);`,
          `const client = process.getBuiltinModule("${name}");`,
          `const client = process.getBuiltinModule(\`${name}\`);`,
          `export { ${member} as client } from "${name}";`,
          `export * from "${name}";`,
          `export * as client from "${name}";`,
        );
      }
    }
    samples.push('import { connect } from "node:\\u0074ls";');
    for (const sample of samples) {
      assert.ok(findRawTlsClients(sample).length > 0, `missed: ${sample}`);
    }
    assert.deepEqual(findRawTlsClients('\n\ntls.connect({ host: "x)" });'), [
      { line: 3, text: 'tls.connect({ host: "x)" })' },
    ]);
    assert.deepEqual(findRawTlsClients("Bun.connect(options)"), [
      { line: 1, text: "Bun.connect(options)" },
    ]);
  });

  it("ignores comments, literal prose and calls to inbound neighbors", () => {
    for (const sample of [
      '// tls.connect(options)\n/* import client from "tls" */',
      'const text = "tls.connect(options)";',
      'const text = `import client from "tls";`;',
      'import { connect } from "node:tlsx";',
      'import { connect } from "./tls";',
      "fetch(url); new URL(url); tls.createServer(options); Bun.serve(options);",
    ]) assert.deepEqual(findRawTlsClients(sample), [], sample);
  });

  it("scans tracked shipped source, not tests or fixtures", () => {
    for (const file of ["src/client.js", "bin/client.mjs", "bridge/extension/background.js", "new/client.ts"]) {
      assert.equal(isScannedSourceFile(file), true, file);
    }
    for (const file of ["test/client.js", "src/client.test.js", "src/fixtures/client.js", "src/types.d.ts", "README.md"]) {
      assert.equal(isScannedSourceFile(file), false, file);
    }
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0").filter(isScannedSourceFile);
    assert.ok(files.includes("src/core.js") && files.includes("bridge/extension/background.js"));
    const verdict = evaluateShippedSource(files.map(file => ({
      path: file, content: readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8"),
    })), ALLOWLIST);
    assert.deepEqual(verdict, { offenders: [], stale: [] },
      "Raw TLS client added: prove URL-derived host/SNI, then pin exact call text and count with provenance.");
  });

  it("pins exact call text, path, count and reviewed host provenance", () => {
    const entry = { file: "src/client.js", call: "http2.connect(baseUrl)", count: 2, reason: "URL-parsed authority" };
    const scan = content => [{ path: entry.file, content }];
    assert.deepEqual(evaluateShippedSource(scan("http2.connect(baseUrl); http2.connect(\nbaseUrl,\n);"), [entry]),
      { offenders: [], stale: [] });
    for (const content of [
      "http2.connect(baseUrl); http2.connect(baseUrl); tls.connect(options);",
      "http2.connect(otherUrl); http2.connect(baseUrl);",
    ]) assert.ok(evaluateShippedSource(scan(content), [entry]).offenders.length);
    for (const content of [
      "http2.connect(baseUrl);", "", "http2.connect(baseUrl);".repeat(3),
    ]) assert.ok(evaluateShippedSource(scan(content), [entry]).stale.length);
    assert.ok(evaluateShippedSource([], [entry]).stale.length);
    assert.ok(evaluateShippedSource([{ path: "src/other.js", content: "http2.connect(baseUrl);" }], [entry]).offenders.length);
    assert.ok(evaluateShippedSource(scan("http2.connect(baseUrl);".repeat(2)), [{ ...entry, reason: "" }]).stale.length);
    assert.ok(evaluateShippedSource(scan(""), [{ ...entry, count: 0 }]).stale.length);
  });
});
