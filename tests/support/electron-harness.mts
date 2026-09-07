import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "vitest";
import { fakeElectron } from "./electron-app-stub.mjs";
import { fakePlugins } from "./electron-vite-plugins.mjs";
import type { Callback } from "./electron-window-stub.mjs";
import { fakeMobileHost, type FakeMobileHost } from "./mobile-host-stub.mjs";
import { isolatedViteServer } from "./vite-server.mjs";

type RegisteredCallback = (...args: never[]) => unknown;
type ComputerUseStub = Record<string, unknown>;
type StartOptions = { computerUse?: ComputerUseStub; mobileHost?: Partial<FakeMobileHost>; updater?: unknown };
type HarnessGlobals = typeof globalThis & {
  __aicodingtoolElectron?: unknown;
  __aicodingtoolComputerUse?: ComputerUseStub;
  __aicodingtoolMobileHost?: FakeMobileHost;
  __aicodingtoolUpdater?: unknown;
};

export function registered<T extends RegisteredCallback>(registry: Map<string, Callback>, name: string): T {
  const callback = registry.get(name);
  if (!callback) throw new Error(`No ${name} callback was registered.`);
  return callback as unknown as T;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function waitFor(predicate: () => unknown, description = "transport state") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Boots src/main/main.ts against a stub Electron so IPC wiring can be driven from a test.
 * Each boot starts its own Vite server, so share one per test file rather than one per test.
 */
export async function startMainProcess(t: TestContext | null, prefix: string, options: StartOptions = {}) {
  let disposed = false;
  const userData = await mkdtemp(path.join(os.tmpdir(), prefix));
  const { electron, windows, appListeners, records } = fakeElectron(userData);
  const globals = globalThis as HarnessGlobals;
  const mobileHost = fakeMobileHost();
  Object.assign(mobileHost.host, options.mobileHost);
  globals.__aicodingtoolMobileHost = mobileHost.host;
  globals.__aicodingtoolElectron = electron;
  globalThis.__dirname = path.join(process.cwd(), "dist/main/main");
  const versions = process.versions as NodeJS.ProcessVersions & { chrome?: string };
  versions.chrome = "141.0.0.0";

  globals.__aicodingtoolUpdater = options.updater;
  const plugins = fakePlugins(options.computerUse !== undefined, options.updater !== undefined);
  const alias: Record<string, string> = { electron: "virtual:fake-electron", "@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs" };
  if (options.updater !== undefined) alias["electron-updater"] = "virtual:fake-updater";

  const { vite, close: closeVite } = await isolatedViteServer({
    logLevel: "silent",
    appType: "custom",
    /** xterm's `module` field points at a file it does not ship, so its real ESM build is named here. */
    resolve: { alias },
    server: { middlewareMode: true },
    ssr: { external: ["@lydell/node-pty"] },
    plugins,
  });
  if (options.computerUse) globals.__aicodingtoolComputerUse = options.computerUse;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const bridge = await vite.ssrLoadModule("/src/main/mobile/bridge.ts");
    await bridge.stopMobileBridge();
    appListeners.get("will-quit")?.();
    await closeVite();
    await rm(userData, { recursive: true, force: true });
    Reflect.deleteProperty(globals, "__aicodingtoolElectron");
    Reflect.deleteProperty(globals, "__aicodingtoolComputerUse");
    Reflect.deleteProperty(globals, "__aicodingtoolMobileHost");
    Reflect.deleteProperty(globals, "__aicodingtoolUpdater");
    Reflect.deleteProperty(globalThis, "__dirname");
    Reflect.deleteProperty(versions, "chrome");
  };
  t?.onTestFinished(dispose);
  try {
    await vite.ssrLoadModule("/src/main/main.ts");
  } catch (cause) {
    await dispose();
    throw cause;
  }
  while (windows.length === 0) await tick();
  /** Boot's last step, awaited so nothing it started is still running when the test tears Vite down. */
  await mobileHost.running;

  const window = windows[0];
  if (!window) throw new Error("Main did not create a window.");
  return {
    ...records,
    dispose,
    userData,
    window,
    mobileHost,
    trusted: { sender: window.webContents },
    untrusted: { sender: {} },
    sentOn: <T = unknown,>(channel: string) => [...window.webContents.sent, ...records.runtimeViews.flatMap((view) => view.webContents.sent)].filter((entry) => entry.channel === channel).map((entry) => entry.event as T),
  };
}

export type MainHarness = Awaited<ReturnType<typeof startMainProcess>>;
