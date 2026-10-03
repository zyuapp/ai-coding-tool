import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { RuntimeDesktop } from "../../src/host/runtime-desktop.ts";
import type { JsonStorage } from "../../src/main/json-storage.ts";

type Handler = (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>;

const fake = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  loaded: Promise.withResolvers<void>(),
  log: [] as string[],
}));

vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: Handler) => { fake.handlers.set(name, handler); } } }));
vi.mock("../../src/host/workspace-runtime.ts", () => ({
  createWorkspaceRuntime: () => ({
    loaded: fake.loaded.promise,
    dispatch: async (input: WorkspaceInput) => { fake.log.push(`dispatch ${input.type}`); },
    restoreDrafts: async () => { fake.log.push("restore drafts"); },
    dispose: () => { fake.loaded.resolve(); },
  }),
}));
vi.mock("../../src/host/runtime-publisher.ts", () => ({
  createRuntimePublisher: () => ({
    revision: 1,
    subscribe: () => () => undefined,
    snapshot: () => ({ snapshot: true }),
    request: async (input: WorkspaceInput) => { fake.log.push(`request ${input.type}`); return { ok: true, revision: 1 }; },
    dispose: () => undefined,
  }),
}));

const { createWorkspaceRuntimeHost } = await import("../../src/main/workspace-runtime-host.ts");

const window = { sender: "the window" };

function host() {
  fake.handlers.clear();
  fake.loaded = Promise.withResolvers<void>();
  fake.log.length = 0;
  const view = { isDestroyed: () => false, webContents: { send: (channel: string) => { fake.log.push(`send ${channel}`); } } };
  const storage = { adopt: () => { fake.log.push("adopt"); return true; }, getItem: () => null } as unknown as JsonStorage;
  const created = createWorkspaceRuntimeHost({ view: () => view as never, trusted: (event) => (event.sender as unknown) === window.sender, desktop: {} as RuntimeDesktop, storage });
  const handler = (name: string) => {
    const found = fake.handlers.get(name);
    assert.ok(found);
    return (...args: unknown[]) => found(window, ...args);
  };
  return { created, request: handler("workspace-runtime:request"), migrate: handler("workspace-runtime:migrate") };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("requests wait for the store to load, then run in the order they arrived", async () => {
  const { request } = host();
  const snapshot = request();
  const input = request({ type: "view.set-prompt", prompt: "Early" });
  await settle();
  assert.deepEqual(fake.log, []);
  fake.loaded.resolve();
  assert.deepEqual(await snapshot, { ok: true, revision: 1 });
  await input;
  assert.deepEqual(fake.log, ["send workspace-runtime:update", "request view.set-prompt"]);
});

test("a request waiting on the store is refused when the runtime closes", async () => {
  const { created, request } = host();
  const pending = request({ type: "view.set-prompt", prompt: "Late" });
  created.close();
  await assert.rejects(pending, /runtime has closed/);
});

test("a migration waits for the store to load before it is applied", async () => {
  const { migrate } = host();
  const migrated = migrate({ "aicodingtool.example": "{}" });
  await settle();
  assert.deepEqual(fake.log, []);
  fake.loaded.resolve();
  await migrated;
  assert.deepEqual(fake.log, ["adopt", "dispatch preferences.loaded", "restore drafts"]);
});
