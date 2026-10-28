import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

export async function discoverLaunchedEndpoint(
  child,
  { profileDir, timeoutMs } = {},
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
