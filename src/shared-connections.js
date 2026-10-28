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

function lease(key, entry, connection) {
  let released;
  const close = () => {
    released ??= release(key, entry);
    return released;
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === "close") return close;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Only plain data is compared structurally. A class instance (an authorizer
// holding its token in a private field, say) compares equal to another one
// with different hidden state, so such options are never shared; functions
// compare by identity, which is exact.
function isPlainData(value) {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(isPlainData);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isPlainData);
}

// An authorizer is a credential: two callers never share one connection
// through it, even with the same authorizer object (#79 review).
export function canShareConnection(options) {
  return options?.client?.authorizer === undefined && isPlainData(options);
}

// `open(options)` makes the real connection; it runs once per browser while a
// lease is held. A caller whose connection options differ from the shared
// connection's gets a connection of its own rather than someone else's
// storage root or dialog policy.
export async function acquireSharedConnection(
  webSocketDebuggerUrl,
  options,
  { open, timeoutMs },
) {
  if (!canShareConnection(options)) return open(options);
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
    const reconnected = connection.cdp.ensureConnected();
    await (timeoutMs === undefined
      ? reconnected
      : withinTimeout(
          reconnected,
          timeoutMs,
          `timed out after ${timeoutMs}ms reconnecting the CDP session on ${webSocketDebuggerUrl}`,
        ));
    return lease(webSocketDebuggerUrl, entry, connection);
  } catch (error) {
    // The browser behind this key is gone or unreachable: evict the entry so
    // the next attach resolves and opens anew instead of joining a dead one.
    if (shared.get(webSocketDebuggerUrl) === entry) shared.delete(webSocketDebuggerUrl);
    await release(webSocketDebuggerUrl, entry);
    throw error;
  }
}
