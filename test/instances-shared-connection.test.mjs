// Contract owner: one approved CDP connection per browser per process, for both
// attach paths: connectNamed (#68) and connect(url) (#76).
// Chrome asks the user to allow remote debugging once per WebSocket connection
// to their own profile, so every extra upgrade is an extra prompt. The fake
// endpoint below counts upgrades at the real HTTP/WebSocket attach boundary.
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { connect } from "../src/connection.js";
import { connectNamed } from "../src/instances.js";

// A browser that answers discovery with its current GUID and, like Chrome,
// only upgrades the WebSocket path of that GUID.
async function fakeCdpEndpoint() {
  let guid = "first";
  const upgrades = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const body = request.url === "/json/version"
      ? { Browser: "FakeChrome/1.0", webSocketDebuggerUrl: webSocketUrl() }
      : request.url === "/json/list" ? [] : null;
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/devtools/browser/${guid}`) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      upgrades.push(guid);
      sockets.add(webSocket);
      webSocket.on("close", () => sockets.delete(webSocket));
      webSocket.on("message", (data) => {
        const { id } = JSON.parse(data.toString());
        webSocket.send(JSON.stringify({ id, result: {} }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  function webSocketUrl() {
    return `${endpoint.replace(/^http/, "ws")}/devtools/browser/${guid}`;
  }
  return {
    endpoint,
    upgrades,
    sockets,
    webSocketUrl,
    // The browser behind the port is now another one. Open sockets are kept,
    // so a stale cached connection is still alive when the lookup happens.
    becomeBrowser(nextGuid) {
      guid = nextGuid;
    },
    dropConnections() {
      for (const webSocket of sockets) webSocket.terminate();
    },
    async close() {
      for (const webSocket of sockets) webSocket.terminate();
      webSockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function register(registryRoot, name, fake) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const record = {
    version: 2,
    name,
    // This process stands in for the browser pid: alive for the whole test.
    pid: process.pid,
    endpoint: fake.endpoint,
    webSocketDebuggerUrl: fake.webSocketUrl(),
    profileDir: null,
    browserPath: process.execPath,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(registryRoot, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function nextTransportEvent(connection, name) {
  return new Promise((resolve) => {
    const off = connection.cdp.transportEvents.on(name, () => {
      off();
      resolve();
    });
  });
}

// Both attach paths run every case below. A named attach finds the browser
// through its registry record (re-registered when the browser changes); a URL
// attach finds it through the endpoint's /json/version.
const attachPaths = [
  {
    label: "connectNamed",
    attach: ({ registryRoot }) => connectNamed("mine", { registryRoot }),
    browserChanged: ({ registryRoot, fake }) => register(registryRoot, "mine", fake),
  },
  {
    label: "connect(url)",
    attach: ({ fake }) => connect(fake.endpoint),
    browserChanged: async () => {},
  },
];

async function withFakeBrowser(attachPath, run) {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-shared-"));
  const fake = await fakeCdpEndpoint();
  const connections = [];
  const context = { fake, registryRoot };
  const attach = async () => {
    const connection = await attachPath.attach(context);
    connections.push(connection);
    return connection;
  };
  try {
    await register(registryRoot, "mine", fake);
    await run({ ...context, attach, browserChanged: () => attachPath.browserChanged(context) });
  } finally {
    await Promise.all(connections.map((c) => c.close().catch(() => {})));
    await fake.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
}

for (const attachPath of attachPaths) {
  test(`repeated ${attachPath.label} calls reuse one connection until the last close`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const second = await attach();
      const third = await attach();
      assert.deepEqual(fake.upgrades, ["first"]);

      // A caller's close releases its handle; the others keep the connection.
      await first.close();
      await second.close();
      await third.cdp.send("Browser.getVersion");
      assert.equal(fake.sockets.size, 1);

      // The last release disconnects, so a script that closes can still exit.
      const [socket] = fake.sockets;
      const closed = once(socket, "close");
      await third.close();
      await closed;
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`concurrent first ${attachPath.label} calls share one upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      await Promise.all([attach(), attach(), attach()]);
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`a dropped ${attachPath.label} connection is replaced by exactly one new upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const dropped = nextTransportEvent(first, "disconnected");
      const restored = nextTransportEvent(first, "reconnected");
      fake.dropConnections();
      await dropped;

      const next = await attach();
      await restored;
      await next.cdp.send("Browser.getVersion");
      await first.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "first"]);
    });
  });

  test(`${attachPath.label} never reuses a connection for a different browser GUID at the same port`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach, browserChanged }) => {
      const old = await attach();
      fake.becomeBrowser("second");
      await browserChanged();

      const fresh = await attach();
      assert.notEqual(fresh.cdp, old.cdp);
      await fresh.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "second"]);
    });
  });
}
