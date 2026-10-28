import { isDeepStrictEqual } from "node:util";

// One CDP connection per browser per process (#68). Chrome asks the user to
// allow remote debugging once per WebSocket connection to their own profile,
// so an attach that opens a fresh socket on every call prompts on every call.
// Entries are keyed by the browser's webSocketDebuggerUrl: it carries the
// browser GUID, so a restarted or different browser never gets a cached
// connection. Each caller gets a lease whose close() is a release; the last
// release disconnects, because an open socket keeps the process alive.
const shared = new Map();

function withinTimeout(pending, timeoutMs, message) {
  let timer;
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function release(key, entry) {
  entry.refs -= 1;
  if (entry.refs > 0) return Promise.resolve();
  if (shared.get(key) === entry) shared.delete(key);
  return entry.ready.then(
    (connection) => connection.close(),
    () => {},
  );
}

function bindTo(target, value) {
  return typeof value === "function" ? value.bind(target) : value;
}

// A lease is one holder's view of the shared connection. Nothing a holder sets
// through it may change what another holder gets (#72 review):
// - setDialogPolicy (on the lease or on lease.cdp) cannot be scoped to one
//   holder's dialogs, because pages are shared between holders. With other
//   holders it moves this holder to a connection of its own with that policy;
//   as the only holder it keeps the connection, which stops being shared so no
//   later attach gets the changed policy.
// - Properties written on the lease stay on the lease; the shared client's
//   properties cannot be written through it, and lease.cdp.close() releases.
// - After close() the lease refuses every use, so a stale handle can never
//   reopen a connection nobody owns.
function lease(key, entry, connection, create) {
  let current = connection;
  let detached = false;
  let closed;
  const own = new Map();
  // Symbols and `then` stay readable, so inspecting or resolving a closed
  // handle doesn't throw; every named member does.
  const ensureOpen = (property) => {
    if (closed && typeof property === "string" && property !== "then") {
      throw new Error("this browser connection handle was closed");
    }
  };
  const close = () => {
    closed ??= detached ? current.close() : release(key, entry);
    return closed;
  };
  const setDialogPolicy = (policy) => {
    ensureOpen("setDialogPolicy");
    if (detached) return current.setDialogPolicy(policy);
    if (entry.refs > 1) {
      const mine = create({ ...entry.options, dialogPolicy: policy });
      mine.initialize().catch(() => {});
      void release(key, entry);
      current = mine;
      detached = true;
      return undefined;
    }
    if (shared.get(key) === entry) shared.delete(key);
    return current.setDialogPolicy(policy);
  };
  let view;
  let viewOf;
  const clientView = () => {
    const client = current.cdp;
    if (viewOf !== client) {
      viewOf = client;
      view = new Proxy(client, {
        get(target, property) {
          ensureOpen(property);
          if (property === "setDialogPolicy") return setDialogPolicy;
          if (property === "close") return close;
          return bindTo(target, Reflect.get(target, property, target));
        },
        set(target, property, value) {
          ensureOpen(property);
          if (!detached) {
            throw new TypeError(`cannot set ${String(property)} on a shared CDP client: every holder of this connection uses it`);
          }
          return Reflect.set(target, property, value, target);
        },
      });
    }
    return view;
  };
  return new Proxy(connection, {
    get(_target, property) {
      if (property === "close") return close;
      ensureOpen(property);
      if (property === "setDialogPolicy") return setDialogPolicy;
      if (property === "cdp") return clientView();
      if (own.has(property)) return own.get(property);
      return bindTo(current, Reflect.get(current, property, current));
    },
    set(_target, property, value) {
      ensureOpen(property);
      own.set(property, value);
      return true;
    },
  });
}

// `open(options)` makes the real connection; it runs once per browser while a
// lease is held. `create(options)` returns one not yet connected, for a holder
// that leaves the shared connection. A caller whose connection options differ
// from the shared connection's gets a connection of its own rather than
// someone else's storage root or dialog policy.
export async function acquireSharedConnection(
  webSocketDebuggerUrl,
  options,
  { open, create, timeoutMs },
) {
  let entry = shared.get(webSocketDebuggerUrl);
  if (entry && !isDeepStrictEqual(entry.options, options)) return open(options);
  if (!entry) {
    entry = { options, refs: 0, ready: open(options) };
    shared.set(webSocketDebuggerUrl, entry);
  }
  entry.refs += 1;
  try {
    const connection = await entry.ready;
    // A dropped socket is already being reconnected by the client; join that
    // attempt (or start one) instead of opening a second connection.
    await withinTimeout(
      connection.cdp.ensureConnected(),
      timeoutMs,
      `timed out after ${timeoutMs}ms reconnecting the CDP session on ${webSocketDebuggerUrl}`,
    );
    return lease(webSocketDebuggerUrl, entry, connection, create);
  } catch (error) {
    await release(webSocketDebuggerUrl, entry);
    throw error;
  }
}
