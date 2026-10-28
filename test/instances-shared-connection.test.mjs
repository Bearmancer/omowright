// Contract owner: one approved CDP connection per browser per process (#68).
// Chrome asks the user to allow remote debugging once per WebSocket connection
// to their own profile, so every extra upgrade is an extra prompt. The fake
// endpoint below counts upgrades at the real HTTP/WebSocket attach boundary.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { connectNamed } from "../src/instances.js";

// A browser that answers discovery with its current GUID and, like Chrome,
// only upgrades the WebSocket path of that GUID.
async function fakeCdpEndpoint() {
  let guid = "first";
  const upgrades = [];
  const sockets = new Set();
  // Each socket's id is its upgrade order; answers records how every socket
  // answered the dialogs emitDialog() raised on it.
  const socketIds = new Map();
  const answers = [];
  const answered = new EventEmitter();
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
      socketIds.set(webSocket, upgrades.length);
      upgrades.push(guid);
      sockets.add(webSocket);
      webSocket.on("close", () => sockets.delete(webSocket));
      webSocket.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        if (method === "Page.handleJavaScriptDialog") {
          answers.push({ socket: socketIds.get(webSocket), accept: params.accept });
          answered.emit("answer");
        }
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
    answers,
    webSocketUrl,
    // One confirm() on every open socket; resolves once each has answered.
    async dialogOnEverySocket() {
      const expected = answers.length + sockets.size;
      const done = new Promise((resolve) => {
        const check = () => {
          if (answers.length < expected) return;
          answered.off("answer", check);
          resolve(answers.slice(expected - sockets.size));
        };
        answered.on("answer", check);
      });
      for (const webSocket of sockets) {
        webSocket.send(JSON.stringify({
          method: "Page.javascriptDialogOpening",
          sessionId: "dialog-session",
          params: { type: "confirm", message: "Leave?", url: "about:blank" },
        }));
      }
      return done;
    },
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

async function withFakeBrowser(run) {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-shared-"));
  const fake = await fakeCdpEndpoint();
  const connections = [];
  const connectAs = async (name) => {
    const connection = await connectNamed(name, { registryRoot });
    connections.push(connection);
    return connection;
  };
  try {
    await register(registryRoot, "mine", fake);
    await run({ fake, registryRoot, connectAs });
  } finally {
    await Promise.all(connections.map((c) => c.close().catch(() => {})));
    await fake.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
}

test("repeated connectNamed calls reuse one connection until the last close", async () => {
  await withFakeBrowser(async ({ fake, connectAs }) => {
    const first = await connectAs("mine");
    const second = await connectAs("mine");
    const third = await connectAs("mine");
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

test("concurrent first connectNamed calls share one upgrade", async () => {
  await withFakeBrowser(async ({ fake, connectAs }) => {
    await Promise.all([connectAs("mine"), connectAs("mine"), connectAs("mine")]);
    assert.deepEqual(fake.upgrades, ["first"]);
  });
});

test("a dropped connection is replaced by exactly one new upgrade", async () => {
  await withFakeBrowser(async ({ fake, connectAs }) => {
    const first = await connectAs("mine");
    const dropped = nextTransportEvent(first, "disconnected");
    const restored = nextTransportEvent(first, "reconnected");
    fake.dropConnections();
    await dropped;

    const next = await connectAs("mine");
    await restored;
    await next.cdp.send("Browser.getVersion");
    await first.cdp.send("Browser.getVersion");
    assert.deepEqual(fake.upgrades, ["first", "first"]);
  });
});

test("a different browser GUID at the same port never reuses the old connection", async () => {
  await withFakeBrowser(async ({ fake, registryRoot, connectAs }) => {
    const old = await connectAs("mine");
    fake.becomeBrowser("second");
    await register(registryRoot, "mine", fake);

    const fresh = await connectAs("mine");
    assert.notEqual(fresh.cdp, old.cdp);
    await fresh.cdp.send("Browser.getVersion");
    assert.deepEqual(fake.upgrades, ["first", "second"]);
  });
});

// Contract owner: a holder's settings stay with that holder (#72 review). The
// shared connection's dialog policy, client and properties are what every other
// holder and every later attach gets, so nothing set through one handle may
// change them. Socket 0 is the shared connection in every row.
const holderSettings = [
  {
    label: "setDialogPolicy on a handle",
    change: (handle) => handle.setDialogPolicy({ accept: false }),
  },
  {
    label: "setDialogPolicy on a handle's cdp",
    change: (handle) => handle.cdp.setDialogPolicy({ accept: false }),
  },
];
const holderCases = [
  ...holderSettings.map((setting) => ({
    label: `${setting.label} applies to that holder only`,
    async run({ fake, connectAs }) {
      const changed = await connectAs("mine");
      await connectAs("mine");
      setting.change(changed);
      await changed.cdp.send("Browser.getVersion");
      await connectAs("mine");
      const answers = await fake.dialogOnEverySocket();
      assert.deepEqual(answers.filter((a) => a.socket === 0), [{ socket: 0, accept: true }]);
      assert.deepEqual(answers.filter((a) => a.socket !== 0).map((a) => a.accept), [false]);
    },
  })),
  {
    label: "a sole holder's setDialogPolicy never reaches a later attach",
    async run({ fake, connectAs }) {
      const changed = await connectAs("mine");
      changed.setDialogPolicy({ accept: false });
      await connectAs("mine");
      const answers = await fake.dialogOnEverySocket();
      assert.deepEqual(
        answers.sort((x, y) => x.socket - y.socket).map((a) => a.accept),
        [false, true],
      );
    },
  },
  {
    label: "a property written on a handle stays on that handle",
    async run({ connectAs }) {
      const writer = await connectAs("mine");
      const other = await connectAs("mine");
      writer.marker = "writer";
      assert.equal(writer.marker, "writer");
      assert.equal(other.marker, undefined);
    },
  },
  {
    label: "a handle cannot rewrite the shared client",
    async run({ fake, connectAs }) {
      const writer = await connectAs("mine");
      const other = await connectAs("mine");
      const before = other.cdp.cdpUrl;
      assert.throws(() => {
        writer.cdp.cdpUrl = "http://127.0.0.1:1";
      }, TypeError);
      assert.equal(other.cdp.cdpUrl, before);
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
  {
    label: "cdp.close() on a handle releases only that handle",
    async run({ fake, connectAs }) {
      const closing = await connectAs("mine");
      const other = await connectAs("mine");
      await closing.cdp.close();
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
      assert.equal(fake.sockets.size, 1);
    },
  },
  {
    label: "a closed handle refuses further use",
    async run({ fake, connectAs }) {
      const closed = await connectAs("mine");
      await connectAs("mine");
      await closed.close();
      assert.throws(() => closed.listTargets(), /handle was closed/);
      assert.throws(() => closed.cdp, /handle was closed/);
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
];

for (const holderCase of holderCases) {
  test(holderCase.label, async () => {
    await withFakeBrowser(holderCase.run);
  });
}
