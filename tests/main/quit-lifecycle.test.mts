import assert from "node:assert/strict";
import { test } from "vitest";
import { registered, startMainProcess, tick, waitFor } from "../support/electron-harness.mjs";
import { isolatedViteServer } from "../support/vite-server.mjs";

type IpcEvent = { sender: unknown };
type ComputerUsePermissions = { accessibility: boolean; screenRecording: boolean };
type QuitComputerUseRuntime = {
  app: { isPackaged: boolean; getAppPath(): string };
  shell: Record<string, unknown>;
  systemPreferences: Record<string, unknown>;
  currentMacOsPermissionStatus(): Promise<ComputerUsePermissions>;
  EmbeddedCuaDriverHost: new () => object;
};
type QuitComputerUseGlobals = typeof globalThis & { __aicodingtoolQuitComputerUse?: QuitComputerUseRuntime };

test("computer-use startup cannot create a host after shutdown begins", { skip: process.platform !== "darwin" }, async (t) => {
  let finishPermissions!: (permissions: ComputerUsePermissions) => void;
  let hosts = 0;
  const permissions = new Promise<ComputerUsePermissions>((resolve) => { finishPermissions = resolve; });
  const globals = globalThis as QuitComputerUseGlobals;
  globals.__aicodingtoolQuitComputerUse = {
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    shell: {},
    systemPreferences: {},
    currentMacOsPermissionStatus: () => permissions,
    EmbeddedCuaDriverHost: class { constructor() { hosts += 1; } },
  };
  const { vite, close: closeVite } = await isolatedViteServer({
    logLevel: "silent",
    appType: "custom",
    resolve: { alias: { electron: "virtual:fake-electron", "@trycua/cua-driver": "virtual:fake-cua-driver" } },
    server: { middlewareMode: true },
    plugins: [{
      name: "fake-computer-use-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === "virtual:fake-electron") return "\0fake-electron";
        if (id === "virtual:fake-cua-driver") return "\0fake-cua-driver";
      },
      load(id) {
        if (id === "\0fake-electron") return "const f = globalThis.__aicodingtoolQuitComputerUse; export const app=f.app, shell=f.shell, systemPreferences=f.systemPreferences;";
        if (id === "\0fake-cua-driver") return "const f = globalThis.__aicodingtoolQuitComputerUse; export const currentMacOsPermissionStatus=f.currentMacOsPermissionStatus, EmbeddedCuaDriverHost=f.EmbeddedCuaDriverHost;";
      },
    }],
  });
  t.onTestFinished(async () => { await closeVite(); Reflect.deleteProperty(globals, "__aicodingtoolQuitComputerUse"); });
  const computerUse = await vite.ssrLoadModule("/src/main/computer-use-host.ts");

  const starting = computerUse.computerUseForRun();
  await computerUse.stopComputerUse();
  finishPermissions({ accessibility: true, screenRecording: true });

  assert.deepEqual(await starting, { status: "unavailable", message: "AI Coding Tool is quitting." });
  assert.equal(hosts, 0);
});

test("quit hides immediately, finishes cleanup once, and reopens only after exit", async (t) => {
  let finishStop!: () => void;
  let runStarts = 0;
  let stopCalls = 0;
  const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
  const main = await startMainProcess(t, "aicodingtool-quit-", {
    computerUse: {
      computerUseForRun: async () => { runStarts += 1; return { status: "setup-required" }; },
      computerUsePermissions: async () => ({ accessibility: false, screenRecording: false }),
      requestComputerUsePermission: async () => ({ accessibility: false, screenRecording: false }),
      stopComputerUse: () => { stopCalls += 1; return stopped; },
    },
  });
  await waitFor(() => main.appListeners.has("activate"));

  main.app.quit();
  assert.equal(main.window.isVisible(), false, "Cmd-Q removes the window before cleanup finishes");
  assert.equal(stopCalls, 1);
  assert.equal(main.completedQuits(), 0);
  const loadStore = registered<(event: IpcEvent) => unknown>(main.handlers, "task-store:load");
  const runCommand = registered<(event: IpcEvent, payload: unknown) => void>(main.listeners, "run:command");
  assert.doesNotThrow(() => loadStore(main.trusted), "queued persistence remains accepted until final shutdown");
  runCommand(main.trusted, { type: "start", channel: "main", taskId: "late", title: "Late", runId: "late-run", prompt: "late", workspaceId: "missing", policy: "confirm", engine: "claude", model: "opus", effort: "high" });
  await tick();
  assert.equal(runStarts, 0, "shutdown refuses new run work without rejecting persistence");

  main.app.quit();
  assert.equal(stopCalls, 1, "a repeated Cmd-Q cannot bypass or duplicate cleanup");
  assert.equal(main.completedQuits(), 0);

  const activate = registered<() => void>(main.appListeners, "activate");
  const openUrl = registered<(event: { preventDefault(): void }, url: string) => void>(main.appListeners, "open-url");
  const secondInstance = registered<(event: unknown, argv: string[]) => void>(main.appListeners, "second-instance");
  activate();
  const url = "aicodingtool://open?path=L3RtcA";
  openUrl({ preventDefault() {} }, url);
  secondInstance({}, ["/Applications/AI Coding Tool.app"]);
  assert.equal(main.relaunches.length, 0, "reopen waits while the old process still owns its resources");
  assert.equal(main.window.isVisible(), false);

  finishStop();
  await waitFor(() => main.completedQuits() === 1);
  assert.equal(main.quitAttempts(), 3);
  assert.equal(main.relaunches.length, 1, "several reopen events schedule one replacement process");
  assert.equal(main.relaunches[0].args?.at(-1), url, "a project URL survives the delayed reopen");
});

test("a requested computer-use restart accepts a project URL before it relaunches", async (t) => {
  let finishStop!: () => void;
  const main = await startMainProcess(t, "aicodingtool-restart-", {
    computerUse: {
      computerUseForRun: async () => ({ status: "setup-required" }),
      computerUsePermissions: async () => ({ accessibility: false, screenRecording: false }),
      requestComputerUsePermission: async () => ({ accessibility: false, screenRecording: false }),
      stopComputerUse: () => new Promise<void>((resolve) => { finishStop = resolve; }),
    },
  });
  const url = "aicodingtool://open?path=L3RtcA";

  registered<(event: IpcEvent) => void>(main.listeners, "computer-use:restart")(main.trusted);
  registered<(event: { preventDefault(): void }, url: string) => void>(main.appListeners, "open-url")({ preventDefault() {} }, url);
  assert.equal(main.relaunches.length, 0);

  finishStop();
  await waitFor(() => main.completedQuits() === 1);
  assert.equal(main.relaunches.length, 1);
  assert.equal(main.relaunches[0].args?.at(-1), url);
});
