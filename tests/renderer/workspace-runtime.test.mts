import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import "../support/renderer-dom.mts";
import type { DesktopAPI, LoadedTaskStore, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";

vi.mock("../../src/renderer/task-workspace/runtime-subscriptions.ts", () => ({ subscribeWorkspaceRuntime: vi.fn(() => ({ stop: () => {}, flush: () => {} })) }));
vi.mock("../../src/renderer/task-workspace/workspace-effects.ts", () => ({ runWorkspaceEffect: vi.fn(async () => {}) }));

const { createWorkspaceRuntime } = await import("../../src/renderer/task-workspace/workspace-runtime.ts");
const { runWorkspaceEffect } = await import("../../src/renderer/task-workspace/workspace-effects.ts");
const { subscribeWorkspaceRuntime } = await import("../../src/renderer/task-workspace/runtime-subscriptions.ts");
const { answerMobileRequest } = await import("../../src/renderer/task-workspace/mobile-bridge.ts");

const messages: ConversationMessage[] = [{ id: "message", kind: "user", text: "persisted text", at: 1 }];

function store(coldCurrent = false): LoadedTaskStore {
  return {
    version: 2, hiddenTasks: 0, projects: [], worktrees: [], lastFolder: null,
    tasks: [
      task("selected", { updatedAt: 2, ...(coldCurrent ? { historySummary: { messageCount: 1, attachmentCount: 0 } } : {}) }),
      task("cold", { historySummary: { messageCount: 1, attachmentCount: 0 } }),
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(runWorkspaceEffect).mockReset();
  vi.mocked(runWorkspaceEffect).mockImplementation(async () => {});
  vi.mocked(subscribeWorkspaceRuntime).mockClear();
  window.desktop = {
    loadTaskStore: async () => store(),
    loadThreadMessages: async () => messages,
    persistTaskStore: async () => {},
    setBadgeCount: () => {},
    publishMobileView: () => {},
  } as unknown as DesktopAPI;
});

test("starting the runtime twice shares its load and subscriptions", async () => {
  const loaded = Promise.withResolvers<LoadedTaskStore>();
  let reads = 0;
  window.desktop.loadTaskStore = () => { reads++; return loaded.promise; };
  const runtime = createWorkspaceRuntime();
  try {
    const first = runtime.start();
    const second = runtime.start();
    assert.equal(first, second);
    assert.equal(reads, 1);
    assert.equal(vi.mocked(subscribeWorkspaceRuntime).mock.calls.length, 1);
    loaded.resolve(store());
    await first;
  } finally {
    runtime.dispose();
  }
});

test("a phone waits for hydrated command acceptance and receives the reducer's refusal", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  window.desktop.loadThreadMessages = () => loaded.promise;
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    let replied = false;
    const response = answerMobileRequest({ state: runtime.getState, dispatch: runtime.dispatch, execute: runtime.execute }, {
      type: "mobile.request", sessionId: "phone", requestId: "request", op: "command",
      command: { type: "task.send", taskId: "cold", text: "hello", project: "missing" },
    }).then((response) => { replied = true; return response; });
    await Promise.resolve();
    assert.equal(replied, false);
    loaded.resolve(messages);
    const result = await response;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /missing/);
  } finally {
    runtime.dispose();
  }
});

test("preparation releases subsequent inputs before the first command's effects finish", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const opened = Promise.withResolvers<void>();
  window.desktop.loadThreadMessages = () => loaded.promise;
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    vi.mocked(runWorkspaceEffect).mockImplementation(async (effect) => {
      if (effect.type === "focus-window") await opened.promise;
    });
    const first = runtime.execute({ type: "task.select", taskId: "cold" });
    loaded.resolve(messages);
    assert.deepEqual(await first.accepted, { ok: true });
    const second = runtime.execute({ type: "view.set-prompt", prompt: "still typing" });
    await second.accepted;
    assert.ok(Object.values(runtime.getState().prompts).includes("still typing"));
    opened.resolve();
    await first.completed;
  } finally {
    opened.resolve();
    runtime.dispose();
  }
});

test("disposing during startup hydration prevents its late response from writing storage", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  window.desktop.loadTaskStore = async () => store(true);
  window.desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const writes = vi.fn(async () => {});
  window.desktop.persistTaskStore = writes;
  const runtime = createWorkspaceRuntime();
  const starting = runtime.start();
  await loading.promise;
  runtime.dispose();
  loaded.resolve(messages);
  await starting;
  assert.equal(writes.mock.calls.length, 0);
});


test("an input waiting for old history cannot execute after the runtime restarts", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  window.desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    const oldCommand = runtime.execute({ type: "task.select", taskId: "cold" });
    await loading.promise;
    runtime.dispose();
    await runtime.start();
    await runtime.flush();
    loaded.resolve(messages);
    await oldCommand.completed;
    assert.equal(runtime.getState().currentId, "selected");
  } finally {
    runtime.dispose();
  }
});

test("a damaged selected transcript leaves other threads and settings usable", async () => {
  window.desktop.loadTaskStore = async () => store(true);
  window.desktop.loadThreadMessages = async (taskId) => {
    if (taskId === "selected") throw new Error("damaged transcript");
    return messages;
  };
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    assert.equal(runtime.getState().storageError, null);
    assert.equal(runtime.getState().writable, true);
    assert.match(runtime.getState().actionError ?? "", /damaged transcript/);
    await runtime.execute({ type: "view.set-settings-open", open: true }).completed;
    assert.equal(runtime.getState().settingsOpen, true);
    await runtime.execute({ type: "task.select", taskId: "cold" }).completed;
    assert.equal(runtime.getState().currentId, "cold");
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "cold")?.messages, messages);
    await runtime.flush();
  } finally {
    runtime.dispose();
  }
});

test("updates during initial backfill reach disk before startup and flush complete", async () => {
  const firstWrite = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  const writes: TaskStoreDelta[] = [];
  window.desktop.persistTaskStore = async (delta) => {
    writes.push(delta);
    if (writes.length === 1) {
      writing.resolve();
      await firstWrite.promise;
    }
  };
  const runtime = createWorkspaceRuntime();
  try {
    const starting = runtime.start();
    await writing.promise;
    await runtime.execute({ type: "task.rename", taskId: "selected", title: "Renamed during write" }).completed;
    firstWrite.resolve();
    await starting;
    await runtime.flush();
    assert.equal(writes.at(-1)?.tasks.find((entry) => entry.task.id === "selected")?.task.title, "Renamed during write");
  } finally {
    firstWrite.resolve();
    runtime.dispose();
  }
});

test("a corrupt transcript does not discard later events and flush waits for the ordered batch", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  window.desktop.loadTaskStore = async () => ({ ...store(), tasks: [...store().tasks, task("broken", { historySummary: { messageCount: 1, attachmentCount: 0 } })] });
  window.desktop.loadThreadMessages = async (taskId) => {
    if (taskId === "broken") throw new Error("broken transcript");
    loading.resolve();
    return loaded.promise;
  };
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    const arrived: string[] = [];
    let coldSequence = 0;
    let selectedSequence = 0;
    const stop = runtime.subscribe(() => {
      const current = runtime.getState();
      const nextCold = current.activeRuns.cold?.sequence ?? 0;
      const nextSelected = current.activeRuns.selected?.sequence ?? 0;
      if (nextCold !== coldSequence) arrived.push(`cold:${nextCold}`);
      if (nextSelected !== selectedSequence) arrived.push(`selected:${nextSelected}`);
      coldSequence = nextCold;
      selectedSequence = nextSelected;
    });
    const batch = runtime.dispatch({ type: "agent.events", events: [
      { type: "run.started", taskId: "broken", runId: "broken-run", sequence: 1, agentInitiated: true },
      { type: "run.started", taskId: "cold", runId: "cold-run", sequence: 1, agentInitiated: true },
      { type: "run.started", taskId: "selected", runId: "selected-run", sequence: 1, agentInitiated: true },
      { type: "assistant.delta", taskId: "cold", runId: "cold-run", sequence: 2, messageId: "cold-reply", text: "Cold reply" },
      { type: "assistant.delta", taskId: "selected", runId: "selected-run", sequence: 2, messageId: "selected-reply", text: "Selected reply" },
    ] });
    await loading.promise;
    let flushed = false;
    const flushing = runtime.flush().then(() => { flushed = true; });
    await Promise.resolve();
    assert.equal(flushed, false);
    loaded.resolve(messages);
    await Promise.all([batch, flushing]);
    assert.equal(flushed, true);
    assert.deepEqual(arrived, ["cold:1", "selected:1", "cold:2", "selected:2"]);
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "cold")?.messages.at(-1)?.text, "Cold reply");
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "selected")?.messages.at(-1)?.text, "Selected reply");
    assert.match(runtime.getState().actionError ?? "", /broken transcript/);
    stop();
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});

test("a batch waiting for history cannot apply remaining events after dispose and restart", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  window.desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    const batch = runtime.dispatch({ type: "agent.events", events: [
      { type: "run.started", taskId: "cold", runId: "cold-run", sequence: 1, agentInitiated: true },
      { type: "run.started", taskId: "selected", runId: "selected-run", sequence: 1, agentInitiated: true },
    ] });
    await loading.promise;
    runtime.dispose();
    const restarted = runtime.start();
    loaded.resolve(messages);
    await Promise.all([batch, restarted]);
    assert.deepEqual(runtime.getState().activeRuns, {});
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});

test("a shutdown retry saves retained changes after a transient storage failure", async () => {
  const runtime = createWorkspaceRuntime();
  try {
    await runtime.start();
    const failed = Promise.withResolvers<void>();
    window.desktop.persistTaskStore = async () => { failed.resolve(); throw new Error("disk unavailable"); };
    await runtime.dispatch({ type: "task.rename", taskId: "selected", title: "Keep this title" });
    await failed.promise;
    await assert.rejects(runtime.flush(), /disk unavailable/);
    assert.equal(runtime.getState().writable, false);
    const writes: TaskStoreDelta[] = [];
    window.desktop.persistTaskStore = async (delta) => { writes.push(delta); };
    await runtime.flush();
    assert.equal(runtime.getState().storageError, null);
    assert.equal(runtime.getState().writable, true);
    assert.ok(writes.some((delta) => delta.tasks.some((change) => change.task.title === "Keep this title")));
  } finally {
    runtime.dispose();
  }
});
