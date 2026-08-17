import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for transport state");
}

test("main transport validates, correlates, cancels, supersedes, and fails runs", async (t) => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "claudex-main-"));
  const handlers = new Map();
  const listeners = new Map();
  const windows = [];
  const agents = [];
  const appListeners = new Map();

  class FakeAgent extends EventEmitter {
    messages = [];
    stderr = new EventEmitter();
    throwOnPost = false;
    postMessage(message) {
      if (this.throwOnPost) throw new Error("post failed");
      this.messages.push(message);
    }
    kill() {}
  }

  class FakeWindow {
    static getAllWindows() { return windows; }
    webContents = { sent: [], send: (channel, event) => this.webContents.sent.push({ channel, event }) };
    constructor(options) { this.options = options; windows.push(this); }
    isDestroyed() { return false; }
    async loadFile() {}
  }

  globalThis.__claudexElectron = {
    app: {
      dock: { setIcon() {} },
      setName() {},
      getAppPath: () => process.cwd(),
      getPath: () => userData,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appListeners.set(name, listener),
      quit() {},
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on: (name, listener) => listeners.set(name, listener),
    },
    utilityProcess: { fork: () => { const agent = new FakeAgent(); agents.push(agent); return agent; } },
  };
  globalThis.__dirname = path.join(process.cwd(), "dist/main/main");

  const vite = await createServer({
    logLevel: "silent",
    appType: "custom",
    resolve: { alias: { electron: "virtual:fake-electron" } },
    server: { middlewareMode: true },
    plugins: [{
      name: "fake-electron",
      enforce: "pre",
      resolveId(id) { if (id === "virtual:fake-electron") return "\0fake-electron"; },
      load(id) {
        if (id === "\0fake-electron") return "const e = globalThis.__claudexElectron; export const app=e.app, BrowserWindow=e.BrowserWindow, dialog=e.dialog, ipcMain=e.ipcMain, utilityProcess=e.utilityProcess;";
      },
    }],
  });
  t.after(async () => {
    await vite.close();
    await rm(userData, { recursive: true, force: true });
    delete globalThis.__claudexElectron;
    delete globalThis.__dirname;
  });
  await vite.ssrLoadModule("/src/main/main.ts");
  while (windows.length === 0) await tick();

  const window = windows[0];
  const trusted = { sender: window.webContents };
  const untrusted = { sender: {} };
  const runCommand = listeners.get("run:command");
  const projectless = await handlers.get("workspace:projectless")(trusted);
  assert.equal((await handlers.get("workspace:changed-files")(untrusted, projectless.id)).status, "error");
  assert.equal((await handlers.get("workspace:changed-files")(trusted, "")).status, "error");

  const command = (taskId, runId) => ({ type: "start", channel: "main", taskId, runId, prompt: "work", workspaceId: projectless.id, policy: "confirm", model: "default", contextWindow: "default" });
  runCommand(untrusted, command("ignored", "ignored"));
  runCommand(trusted, command("cancelled", "run-cancelled"));
  runCommand(trusted, { type: "cancel", taskId: "cancelled", runId: "run-cancelled" });
  await tick();
  assert.equal(agents[0].messages.some((message) => message.runId === "run-cancelled"), false);

  runCommand(trusted, command("old", "run-old"));
  runCommand(trusted, command("new", "run-new"));
  await waitFor(() => agents[0].messages.some((message) => message.runId === "run-new"));
  assert.equal(agents[0].messages.some((message) => message.runId === "run-old"), false);
  assert.equal(agents[0].messages.some((message) => message.runId === "run-new"), true);

  runCommand(trusted, { ...command("missing", "run-missing"), workspaceId: "unknown" });
  const sent = () => window.webContents.sent.map(({ event }) => event);
  await waitFor(() => sent().some((event) => event.runId === "run-missing" && event.type === "run.status" && event.status === "failed"));
  assert.deepEqual(sent().filter((event) => event.runId === "run-cancelled" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-old" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-missing" && event.type === "run.status").map((event) => event.status), ["failed"]);

  agents[0].emit("exit", 9);
  assert.deepEqual(sent().filter((event) => event.runId === "run-new" && event.type === "run.status").map((event) => event.status), ["failed"]);

  runCommand(trusted, command("post", "run-post"));
  await waitFor(() => agents[1]?.messages.some((message) => message.runId === "run-post"));
  agents[1].throwOnPost = true;
  runCommand(trusted, { type: "cancel", taskId: "post", runId: "run-post" });
  assert.equal(window.webContents.sent.map(({ event }) => event).some((event) => event.runId === "run-post" && event.type === "run.status" && event.status === "failed"), true);
});
