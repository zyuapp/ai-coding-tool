import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import "../support/renderer-dom.mts";
import type { DesktopAPI, LoadedTaskStore, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { EngineStatus } from "../../src/domain/agent-engine.ts";
import { systemEffects } from "../../src/host/system-effects.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";

vi.mock("../../src/host/runtime-subscriptions.ts", () => ({ subscribeWorkspaceRuntime: vi.fn(() => ({ stop: () => {}, flush: () => {} })) }));
vi.mock("../../src/host/workspace-effects.ts", () => ({ runWorkspaceEffect: vi.fn(async () => {}) }));

const { createWorkspaceRuntime } = await import("../../src/host/workspace-runtime.ts");
const { runWorkspaceEffect } = await import("../../src/host/workspace-effects.ts");
const { subscribeWorkspaceRuntime } = await import("../../src/host/runtime-subscriptions.ts");
const { answerMobileRequest } = await import("../../src/host/mobile-bridge.ts");
const { noComputers } = await import("../../src/host/no-computers.ts");

let desktop: DesktopAPI;

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
  desktop = {
    loadTaskStore: async () => store(),
    loadThreadMessages: async () => messages,
    persistTaskStore: async () => {},
    setBadgeCount: () => {},
    publishMobileView: () => {},
  } as unknown as DesktopAPI;
});

test("the runtime serves a paired transcript from disk without changing selection or exposing other threads", async () => {
  const loads: string[] = [];
  desktop.loadThreadMessages = async (id) => { loads.push(id); return messages; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    const selected = runtime.getState().currentId;
    const response = await runtime.queryThreads({ kind: "thread-read", threadId: "cold", limit: 1 });
    assert.ok(!Array.isArray(response));
    assert.equal(response.thread.id, "cold");
    assert.deepEqual(response.messages, [{ kind: "user", text: "persisted text", at: 1 }]);
    assert.deepEqual(loads, ["cold"]);
    assert.equal(runtime.getState().currentId, selected);
    const matches = await runtime.queryThreads({ kind: "thread-list", search: "persisted", limit: 1 });
    assert.ok(Array.isArray(matches));
    assert.deepEqual(matches.map((row) => row.id), ["cold"]);
  } finally { runtime.dispose(); }
});

test("the runtime persists snooze, restores its timer and files it back into Priority at expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_800_000_000_000);
  let saved = store();
  saved.tasks[0].outcome = "finished";
  desktop.loadTaskStore = async () => saved;
  desktop.persistTaskStore = async (delta) => {
    saved = { ...saved, tasks: saved.tasks.map((thread) => {
      const update = delta.tasks.find(({ task }) => task.id === thread.id);
      return update ? { ...update.task, messages: thread.messages } : thread;
    }) };
  };
  vi.mocked(runWorkspaceEffect).mockImplementation(async (effect, host) => {
    if (effect.type === "schedule-snooze-expiry") host.scheduleSnoozeExpiry(effect.at);
  });
  let runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    await runtime.dispatch({ type: "task.snooze", taskId: "selected", hours: 1 });
    await runtime.flush();
    const deadline = Date.now() + 3_600_000;
    assert.equal(saved.tasks[0].snoozedUntil, deadline);
    runtime.dispose();
    runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
    await runtime.start();
    assert.equal(runtime.getState().threads[0].snoozedUntil, deadline);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await runtime.flush();
    assert.equal(runtime.getState().threads[0].snoozedUntil, undefined);
    assert.equal(runtime.getState().threads[0].outcome, "finished");
    assert.equal(saved.tasks[0].snoozedUntil, undefined);
  } finally { runtime.dispose(); vi.useRealTimers(); }
});

test("starting the runtime twice shares its load and subscriptions", async () => {
  const loaded = Promise.withResolvers<LoadedTaskStore>();
  let reads = 0;
  desktop.loadTaskStore = () => { reads++; return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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

test("the engine check started by subscriptions applies its result after startup", async () => {
  const checked = Promise.withResolvers<EngineStatus>();
  const status: EngineStatus = { claude: { access: "ready" }, codex: { access: "ready" } };
  desktop.engineStatus = () => checked.promise;
  vi.mocked(subscribeWorkspaceRuntime).mockImplementationOnce((host) => {
    void host.dispatch({ type: "engine.read" });
    return { stop: () => {}, flush: () => {} };
  });
  vi.mocked(runWorkspaceEffect).mockImplementation(async (effect, host) => {
    if (effect.type === "engine.read") await systemEffects["engine.read"](effect, host);
  });
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    assert.equal(runtime.getState().engineChecking, true);
    checked.resolve(status);
    await runtime.flush();
    assert.equal(runtime.getState().engineChecking, false);
    assert.deepEqual(runtime.getState().engineStatus, status);
  } finally {
    checked.resolve(status);
    runtime.dispose();
  }
});

test("draft text survives a restart, cleared drafts stay cleared, and side chats stay temporary", async () => {
  let runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "Unsent text" });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "draft:", prompt: "New task draft" });
    await runtime.dispatch({ type: "side-chat.open", chatId: "temporary" });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "temporary", prompt: "Private side draft" });
    await runtime.flush();
    assert.deepEqual(JSON.parse(localStorage.getItem("aicodingtool.draft-prompts.v1")!), { selected: "Unsent text", "draft:": "New task draft" });
    runtime.dispose();
    runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
    await runtime.start();
    assert.deepEqual(runtime.getState().prompts, { selected: "Unsent text", "draft:": "New task draft" });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "" });
    await runtime.flush();
    runtime.dispose();
    runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
    await runtime.start();
    assert.deepEqual(runtime.getState().prompts, { "draft:": "New task draft" });
  } finally {
    runtime.dispose();
  }
});

test("draft writes are coalesced and a refused write keeps text available for a quit retry", async () => {
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  const write = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, "setItem");
  try {
    await runtime.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "first" });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "latest" });
    assert.equal(write.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(250);
    assert.equal(write.mock.calls.length, 1);
    write.mockImplementation(() => { throw new Error("Draft storage full"); });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "retained" });
    await vi.advanceTimersByTimeAsync(250);
    assert.match(runtime.getState().actionError!, /Draft storage full/);
    await assert.rejects(runtime.flush(), /Draft storage full/);
    assert.equal(runtime.getState().prompts.selected, "retained");
    write.mockRestore();
    await runtime.flush();
    assert.equal(JSON.parse(localStorage.getItem("aicodingtool.draft-prompts.v1")!).selected, "retained");
  } finally {
    runtime.dispose();
    write.mockRestore();
    vi.useRealTimers();
  }
});

test("a phone waits for hydrated command acceptance and receives the reducer's refusal", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  desktop.loadThreadMessages = () => loaded.promise;
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.loadThreadMessages = () => loaded.promise;
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.loadTaskStore = async () => store(true);
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const writes = vi.fn(async () => {});
  desktop.persistTaskStore = writes;
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    const oldCommand = runtime.execute({ type: "task.send", taskId: "cold", text: "hello" });
    await loading.promise;
    runtime.dispose();
    await runtime.start();
    await runtime.flush();
    loaded.resolve(messages);
    await oldCommand.completed;
    assert.deepEqual(runtime.getState().pendingRuns, {});
  } finally {
    runtime.dispose();
  }
});

test("a damaged selected transcript leaves other threads and settings usable", async () => {
  desktop.loadTaskStore = async () => store(true);
  desktop.loadThreadMessages = async (taskId) => {
    if (taskId === "selected") throw new Error("damaged transcript");
    return messages;
  };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.persistTaskStore = async (delta) => {
    writes.push(delta);
    if (writes.length === 1) {
      writing.resolve();
      await firstWrite.promise;
    }
  };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.loadTaskStore = async () => ({ ...store(), tasks: [...store().tasks, task("broken", { historySummary: { messageCount: 1, attachmentCount: 0 } })] });
  desktop.loadThreadMessages = async (taskId) => {
    if (taskId === "broken") throw new Error("broken transcript");
    loading.resolve();
    return loaded.promise;
  };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
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
  const hosted = { ...desktop, ...noComputers };
  const runtime = createWorkspaceRuntime({ desktop: hosted, storage: localStorage });
  try {
    await runtime.start();
    const failed = Promise.withResolvers<void>();
    hosted.persistTaskStore = async () => { failed.resolve(); throw new Error("disk unavailable"); };
    await runtime.dispatch({ type: "task.rename", taskId: "selected", title: "Keep this title" });
    await failed.promise;
    await assert.rejects(runtime.flush(), /disk unavailable/);
    assert.equal(runtime.getState().writable, false);
    const writes: TaskStoreDelta[] = [];
    hosted.persistTaskStore = async (delta) => { writes.push(delta); };
    await runtime.flush();
    assert.equal(runtime.getState().storageError, null);
    assert.equal(runtime.getState().writable, true);
    assert.ok(writes.some((delta) => delta.tasks.some((change) => change.task.title === "Keep this title")));
  } finally {
    runtime.dispose();
  }
});

/** Lets queued microtasks and timers run, so anything not held by a pending read has settled. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a thread's history read holds only inputs for that thread", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    await runtime.dispatch({ type: "agent.events", events: [{ type: "run.started", taskId: "selected", runId: "selected-run", sequence: 1, agentInitiated: true }] });
    runtime.execute({ type: "task.select", taskId: "cold" });
    assert.equal(runtime.getState().currentId, "cold", "selection lands before the transcript does");
    assert.ok(runtime.getState().threads.find((thread) => thread.id === "cold")?.historySummary, "the selected thread shows as loading");
    await loading.promise;
    const first = runtime.dispatch({ type: "agent.events", events: [
      { type: "run.started", taskId: "cold", runId: "cold-run", sequence: 1, agentInitiated: true },
      { type: "assistant.delta", taskId: "cold", runId: "cold-run", sequence: 2, messageId: "first", text: "First" },
    ] });
    const second = runtime.dispatch({ type: "agent.events", events: [{ type: "assistant.delta", taskId: "cold", runId: "cold-run", sequence: 3, messageId: "second", text: "Second" }] });
    const done: string[] = [];
    const cancel = runtime.execute({ type: "run.cancel", taskId: "selected" }).completed.then(() => done.push("cancel"));
    const settings = runtime.execute({ type: "view.set-settings-open", open: true }).completed.then(() => done.push("settings"));
    await settle();
    assert.deepEqual(done.sort(), ["cancel", "settings"]);
    assert.equal(runtime.getState().settingsOpen, true);
    assert.ok(vi.mocked(runWorkspaceEffect).mock.calls.some(([effect]) => effect.type === "send-run-command" && effect.command.type === "cancel" && effect.command.taskId === "selected"));
    assert.equal(runtime.getState().activeRuns.cold, undefined, "the cold thread's events wait for its transcript");
    loaded.resolve(messages);
    await Promise.all([first, second, cancel, settings]);
    assert.deepEqual(runtime.getState().threads.find((thread) => thread.id === "cold")?.messages.map((message) => message.text), ["persisted text", "First", "Second"]);
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});

test("a current-thread command waiting for history keeps its thread when the selection moves on", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    await runtime.dispatch({ type: "view.set-prompt", taskId: "cold", prompt: "for the cold thread" });
    await runtime.dispatch({ type: "view.set-prompt", taskId: "selected", prompt: "for the selected thread" });
    runtime.execute({ type: "task.select", taskId: "cold" });
    await loading.promise;
    const send = runtime.execute({ type: "task.send" });
    runtime.execute({ type: "task.select", taskId: "selected" });
    await settle();
    assert.equal(runtime.getState().currentId, "selected");
    loaded.resolve(messages);
    await send.completed;
    const pending = Object.values(runtime.getState().pendingRuns);
    assert.deepEqual(pending.map((run) => [run.taskId, run.text]), [["cold", "for the cold thread"]]);
    assert.equal(runtime.getState().prompts.selected, "for the selected thread");
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});

test("inputs queued behind a thread's history read report the closed runtime", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    const send = runtime.execute({ type: "task.send", taskId: "cold", text: "hello" });
    const rename = runtime.execute({ type: "task.rename", taskId: "cold", title: "Renamed" });
    await loading.promise;
    runtime.dispose();
    loaded.resolve(messages);
    const closed = { ok: false, message: "The workspace runtime is closed." };
    assert.deepEqual(await send.completed, closed);
    assert.deepEqual(await rename.completed, closed);
    assert.deepEqual(runtime.getState().pendingRuns, {});
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});

test("selecting a coordinated thread loads the tab it opens in the coordinator's dock", async () => {
  const loads: string[] = [];
  desktop.loadTaskStore = async () => ({ ...store(), tasks: [...store().tasks, task("lead", { role: "coordinator" }), task("worker", { parentId: "lead", historySummary: { messageCount: 1, attachmentCount: 0 } })] });
  desktop.loadThreadMessages = async (taskId) => { loads.push(taskId); return messages; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    await runtime.execute({ type: "task.select", taskId: "worker" }).completed;
    assert.equal(runtime.getState().currentId, "lead");
    await runtime.flush();
    assert.deepEqual(loads, ["worker"]);
    assert.equal(runtime.getState().threads.find((thread) => thread.id === "worker")?.messages, messages);
  } finally {
    runtime.dispose();
  }
});

test("a screen command whose history read outlasts the selection is refused rather than run on the new thread", async () => {
  const loaded = Promise.withResolvers<ConversationMessage[]>();
  const loading = Promise.withResolvers<void>();
  desktop.loadThreadMessages = () => { loading.resolve(); return loaded.promise; };
  const runtime = createWorkspaceRuntime({ desktop: { ...desktop, ...noComputers }, storage: localStorage });
  try {
    await runtime.start();
    runtime.execute({ type: "task.select", taskId: "cold" });
    await loading.promise;
    const open = runtime.execute({ type: "side-chat.open", chatId: "chat" });
    const find = runtime.execute({ type: "view.shortcut", action: "find.open", surface: "any" });
    await settle();
    runtime.execute({ type: "task.select", taskId: "selected" });
    loaded.resolve(messages);
    const moved = { ok: false, message: "The thread on screen changed before this could run." };
    assert.deepEqual(await open.completed, moved);
    assert.deepEqual(await find.completed, moved);
    assert.deepEqual(runtime.getState().sideChats, []);
    assert.equal(runtime.getState().find, null);
  } finally {
    loaded.resolve(messages);
    runtime.dispose();
  }
});
