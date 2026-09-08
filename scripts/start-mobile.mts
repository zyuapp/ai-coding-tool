import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";
import { previewElectron } from "./mobile-preview-electron.mts";

// Vite's native tooling runs under Node; Electron hosts only the phone window.
const root = path.resolve(import.meta.dirname, "..");
const electron = await previewElectron(root);
const server = await createServer({ root, configFile: path.join(root, "vite.mobile.config.mts") });
let preview: ChildProcess | null = null;
let stopping = false;

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (preview) {
    const child = preview;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
    deadline.unref();
    child.once("exit", () => clearTimeout(deadline));
  }
  await server.close();
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

try {
  await server.listen();
  if (!stopping) {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("The mobile preview server has no local address.");
    const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
    preview = spawn(electron, [path.join(root, "scripts/mobile-preview.mjs"), url], {
      cwd: root,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    preview.once("error", (error) => { console.error("Could not launch Mobile Preview:", error); void stop(1); });
    preview.once("exit", (code, signal) => {
      if (signal && !stopping) console.error(`Mobile Preview exited with ${signal}.`);
      preview = null;
      void stop(code ?? 1);
    });
  }
} catch (error) {
  console.error("Could not start Mobile Preview:", error);
  await stop(1);
}
