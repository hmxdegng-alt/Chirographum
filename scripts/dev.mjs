// Starts the Vite dev server and opens Electron pointing at it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";

const extraArgs = process.argv.slice(2);
const child = spawn(electronPath, [".", ...extraArgs], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
