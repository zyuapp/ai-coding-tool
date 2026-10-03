import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { LoadedTaskStore } from "../../src/contracts/ipc.ts";
import type { RuntimeDesktop } from "../../src/host/runtime-desktop.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";

vi.mock("../../src/host/runtime-subscriptions.ts", () => ({ subscribeWorkspaceRuntime: vi.fn(() => ({ stop: () => {}, flush: () => {} })) }));
vi.mock("../../src/host/workspace-effects.ts", () => ({ runWorkspaceEffect: vi.fn(async () => {}) }));

const { createWorkspaceRuntime } = await import("../../src/host/workspace-runtime.ts");
const { noComputers } = await import("../../src/host/no-computers.ts");

const messages: ConversationMessage[] = [{ id: "message", kind: "user", text: "persisted text", at: 1 }];

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function store(): LoadedTaskStore {
  return {
    version: 2, hiddenTasks: 0, projects: [], worktrees: [], lastFolder: null,
    tasks: [task("selected", { updatedAt: 2, historySummary: { messageCount: 1, attachmentCount: 0 } })],
  };
}

function desktop(overrides: Partial<RuntimeDesktop>) {
  return {
    loadTaskStore: async () => store(),
    loadThreadMessages: async () => messages,
    persistTaskStore: async () => {},
    setBadgeCount: () => {},
    publishMobileView: () => {},
    ...noComputers,
    ...overrides,
  } as unknown as RuntimeDesktop;
}

test("loaded settles with the store in, before the current thread's history has loaded", async () => {
  const history = Promise.withResolvers<ConversationMessage[]>();
  const runtime = createWorkspaceRuntime({ desktop: desktop({ loadThreadMessages: () => history.promise }), storage: memoryStorage() });
  try {
    const starting = runtime.start();
    await runtime.loaded;
    assert.equal(runtime.getState().currentId, "selected");
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "selected")?.messages.length, 0);
    history.resolve(messages);
    await starting;
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "selected")?.messages, messages);
  } finally { runtime.dispose(); }
});

test("loaded settles when the store cannot be read", async () => {
  const runtime = createWorkspaceRuntime({ desktop: desktop({ loadTaskStore: async () => { throw new Error("unreadable"); } }), storage: memoryStorage() });
  try {
    await runtime.start();
    await runtime.loaded;
  } finally { runtime.dispose(); }
});

test("loaded settles when the runtime is disposed during the load or before it starts", async () => {
  const load = Promise.withResolvers<LoadedTaskStore>();
  const during = createWorkspaceRuntime({ desktop: desktop({ loadTaskStore: () => load.promise }), storage: memoryStorage() });
  const starting = during.start();
  during.dispose();
  await during.loaded;
  load.resolve(store());
  await starting;

  const unstarted = createWorkspaceRuntime({ desktop: desktop({}), storage: memoryStorage() });
  unstarted.dispose();
  await unstarted.loaded;
});
