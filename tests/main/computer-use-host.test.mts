import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isolatedViteServer } from "../support/vite-server.mjs";

type ComputerUseGlobals = typeof globalThis & { __aicodingtoolLinuxCua?: Record<string, unknown> };

test("Linux computer use needs no macOS permission flow and starts the bundled host", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-linux-cua-"));
  const executable = path.join(root, "vendor", "cua-driver", "cua-driver");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "driver");
  await chmod(executable, 0o755);
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  process.env.DISPLAY = ":99";
  Reflect.deleteProperty(process.env, "WAYLAND_DISPLAY");
  let hosts = 0;
  let stops = 0;
  const connection = {
    mcp: { command: executable, args: ["mcp", "--embedded"], environment: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }] },
  };
  const globals = globalThis as ComputerUseGlobals;
  globals.__aicodingtoolLinuxCua = {
    app: { isPackaged: false, getAppPath: () => root },
    shell: {},
    systemPreferences: {},
    EmbeddedCuaDriverHost: class {
      constructor(binary: string, bundleId: string) {
        assert.equal(binary, executable);
        assert.equal(bundleId, "com.zyuapp.aicodingtool");
        hosts += 1;
      }
      connection() { return null; }
      async start() { return connection; }
      async stop() { stops += 1; }
      uniffiDestroy() {}
    },
  };
  const { vite, close: closeVite } = await isolatedViteServer({
    logLevel: "silent",
    appType: "custom",
    resolve: { alias: { electron: "virtual:linux-electron", "@trycua/cua-driver": "virtual:linux-cua-driver" } },
    server: { middlewareMode: true },
    plugins: [{
      name: "linux-computer-use-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === "virtual:linux-electron") return "\0linux-electron";
        if (id === "virtual:linux-cua-driver") return "\0linux-cua-driver";
      },
      load(id) {
        if (id === "\0linux-electron") return "const f=globalThis.__aicodingtoolLinuxCua; export const app=f.app, shell=f.shell, systemPreferences=f.systemPreferences;";
        if (id === "\0linux-cua-driver") return "const f=globalThis.__aicodingtoolLinuxCua; export const EmbeddedCuaDriverHost=f.EmbeddedCuaDriverHost;";
      },
    }],
  });
  t.onTestFinished(async () => {
    await closeVite();
    await rm(root, { recursive: true, force: true });
    if (previousDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
    else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) Reflect.deleteProperty(process.env, "WAYLAND_DISPLAY");
    else process.env.WAYLAND_DISPLAY = previousWayland;
    Reflect.deleteProperty(globals, "__aicodingtoolLinuxCua");
  });

  const computerUse = await vite.ssrLoadModule("/src/main/computer-use-host.ts");
  const ready = {
    accessibility: true,
    screenRecording: true,
    linuxRuntime: { status: "available", display: "x11", message: "Computer use is ready for this X11 session." },
  };
  assert.deepEqual(await computerUse.computerUsePermissions(), ready);
  assert.deepEqual(await computerUse.requestComputerUsePermission("accessibility"), ready);
  assert.deepEqual(await computerUse.computerUseForRun(), {
    status: "available",
    mcp: { command: executable, args: ["mcp", "--embedded"], env: { CUA_DRIVER_EMBEDDED: "1" } },
  });
  assert.equal(hosts, 1);
  await computerUse.stopComputerUse();
  assert.equal(stops, 1);
});
