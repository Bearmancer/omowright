// Harness child: a caller that connects the pipe transport and then waits to be
// killed. The test SIGKILLs this process's whole group, the way an eval cell or
// `timeout -s KILL` ends a caller, and checks that the browser is not in that group.
import { PipeCdpClient } from "../../src/pipe.js";

const [fixture] = process.argv.slice(2);
const client = new PipeCdpClient({
  browserPath: process.execPath,
  browserArgs: [fixture],
  spawnOptions: { env: { ...process.env, FAKE_ON_TERM: "exit" } },
});
await client.ensureConnected();
process.stdout.write(`BROWSER_PID ${client.childProcess.pid}\n`);
setInterval(() => {}, 60_000);
