import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import "../support/renderer-dom.mts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceBridge, WorkspaceUpdate } from "../../src/contracts/workspace-runtime.ts";
import type { WorkspaceCommandResult } from "../../src/application/workspace-reducer.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";

vi.mock("../../src/renderer/task-workspace/workspace-runtime.ts", () => ({ createWorkspaceRuntime: vi.fn() }));
vi.mock("../../src/renderer/task-workspace/terminal-views.ts", () => ({ clearTerminalSearch: vi.fn(), disposeTerminalView: vi.fn(), searchTerminalView: vi.fn() }));
const { createWorkspaceConnection } = await import("../../src/renderer/task-workspace/workspace-connection.ts");

function transport() {
  const listeners = new Set<(update: WorkspaceUpdate) => void>();
  const request = vi.fn<WorkspaceBridge["request"]>(async () => ({ ok: true }));
  window.workspace = {
    owner: false,
    request,
    onUpdate: (listener: (update: WorkspaceUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onSurface: () => () => {},
  } as unknown as WorkspaceBridge;
  return { request, emit: (update: WorkspaceUpdate) => { for (const listener of listeners) listener(update); } };
}

afterEach(() => { delete window.workspace; });

test("a connection waits for one complete snapshot and ignores duplicate patches", async () => {
  const bridge = transport();
  const pending = Promise.withResolvers<{ ok: true }>();
  bridge.request.mockReturnValue(pending.promise);
  const connection = createWorkspaceConnection();
  try {
    const started = connection.start();
    assert.equal(connection.start(), started);
    for (let revision = 0; revision < 20; revision += 1) bridge.emit({ revision, patches: [{ path: ["actionError"], value: "partial" }] });
    await Promise.resolve();
    assert.equal(bridge.request.mock.calls.length, 1);
    assert.equal(connection.getState().actionError, null);
    const state = emptyWorkspaceState();
    bridge.emit({ revision: 20, state });
    pending.resolve({ ok: true });
    await started;
    bridge.emit({ revision: 20, patches: [{ path: ["actionError"], value: "duplicate" }] });
    assert.equal(connection.getState(), state);
    bridge.emit({ revision: 21, patches: [{ path: ["actionError"], value: "current" }] });
    assert.equal(connection.getState().actionError, "current");
    assert.equal(bridge.request.mock.calls.length, 1);
  } finally {
    connection.dispose();
  }
});

test("a reopened connection accepts a restarted runtime's lower revision snapshot", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  let revision = 100;
  let state = { ...emptyWorkspaceState(), actionError: "old runtime" };
  bridge.request.mockImplementation(async () => { bridge.emit({ revision, state }); return { ok: true }; });
  try {
    await connection.start();
    assert.equal(connection.getState().actionError, "old runtime");
    connection.dispose();
    revision = 0;
    state = { ...emptyWorkspaceState(), actionError: "new runtime" };
    await connection.start();
    assert.equal(connection.getState().actionError, "new runtime");
    bridge.emit({ revision: 1, patches: [{ path: ["actionError"], value: "new update" }] });
    assert.equal(connection.getState().actionError, "new update");
  } finally {
    connection.dispose();
  }
});

test("missed revisions request one replacement snapshot while updates keep arriving", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  const initial = emptyWorkspaceState();
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 4, state: initial }); return { ok: true }; });
  try {
    await connection.start();
    const pending = Promise.withResolvers<{ ok: true }>();
    bridge.request.mockReturnValue(pending.promise);
    for (let revision = 6; revision < 15; revision += 1) bridge.emit({ revision, patches: [] });
    await Promise.resolve();
    assert.equal(bridge.request.mock.calls.length, 2);
    assert.equal(connection.getState(), initial);
    bridge.emit({ revision: 15, state: { ...initial, actionError: "caught up" } });
    pending.resolve({ ok: true });
    bridge.emit({ revision: 16, patches: [{ path: ["actionError"], value: null }] });
    assert.equal(connection.getState().actionError, null);
  } finally {
    connection.dispose();
  }
});

test("transport failures are displayed and command refusals preserve their existing presentation", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: emptyWorkspaceState() }); return { ok: true }; });
  try {
    await connection.start();
    bridge.request.mockResolvedValueOnce({ ok: false, message: "Thread unavailable" });
    await assert.doesNotReject(connection.dispatch({ type: "task.select", taskId: "gone" }));
    assert.equal(connection.getState().actionError, null, "command errors are already projected by the runtime in the relevant panel");
    bridge.request.mockRejectedValueOnce(new Error("Runtime disconnected"));
    await assert.doesNotReject(connection.dispatch({ type: "view.set-prompt", prompt: "hello" }));
    assert.equal(connection.getState().actionError, "Runtime disconnected");
    bridge.emit({ revision: 1, patches: [{ path: ["currentId"], value: "selected" }] });
    assert.equal(connection.getState().actionError, null, "a transport error never changes the authoritative patch baseline");
    assert.equal(connection.getState().currentId, "selected");
  } finally {
    connection.dispose();
  }
});

test("rapid typing stays synchronous while older patches and acknowledgements arrive", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  const initial = { ...emptyWorkspaceState(), currentId: "thread", threads: [task("thread")] };
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: initial }); return { ok: true }; });
  try {
    await connection.start();
    const pending = Array.from({ length: 3 }, () => Promise.withResolvers<WorkspaceCommandResult>());
    for (const request of pending) bridge.request.mockReturnValueOnce(request.promise);
    const first = connection.dispatch({ type: "view.set-prompt", prompt: "h" });
    assert.equal(connection.getState().prompts.thread, "h");
    const second = connection.dispatch({ type: "view.set-prompt", prompt: "he" });
    assert.equal(connection.getState().prompts.thread, "he");
    const third = connection.dispatch({ type: "view.set-prompt", prompt: "hey" });
    assert.equal(connection.getState().prompts.thread, "hey");
    assert.deepEqual(bridge.request.mock.calls.slice(1).map(([input]) => input), [
      { type: "view.set-prompt", taskId: "thread", prompt: "h" },
      { type: "view.set-prompt", taskId: "thread", prompt: "he" },
      { type: "view.set-prompt", taskId: "thread", prompt: "hey" },
    ]);

    bridge.emit({ revision: 1, patches: [{ path: ["prompts", "thread"], value: "h" }] });
    pending[0].resolve({ ok: true });
    await first;
    assert.equal(connection.getState().prompts.thread, "hey");
    bridge.emit({ revision: 2, patches: [{ path: ["prompts", "thread"], value: "he" }] });
    assert.equal(connection.getState().prompts.thread, "hey");
    bridge.emit({ revision: 3, patches: [{ path: ["prompts", "thread"], value: "hey" }] });
    pending[2].resolve({ ok: true });
    await third;
    assert.equal(connection.getState().prompts.thread, "hey");
    pending[1].resolve({ ok: true });
    await second;
    assert.equal(connection.getState().prompts.thread, "hey", "an older reply cannot restore a superseded edit");
    bridge.emit({ revision: 4, patches: [{ path: ["prompts", "thread"], value: "Updated elsewhere" }] });
    assert.equal(connection.getState().prompts.thread, "Updated elsewhere", "acknowledged text no longer overlays authoritative updates");
  } finally {
    connection.dispose();
  }
});

test("prompt and annotation edits keep the composer they were typed in across selection changes", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  const initial = {
    ...emptyWorkspaceState(), currentId: null, draftProjectId: "project",
    projects: [{ id: "project", root: "/project" }], threads: [task("other")],
    annotations: { "draft:project": [{ id: "annotation", quote: "selected text", note: "" }] },
  };
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: initial }); return { ok: true }; });
  try {
    await connection.start();
    const prompted = Promise.withResolvers<WorkspaceCommandResult>();
    const annotated = Promise.withResolvers<WorkspaceCommandResult>();
    bridge.request.mockReturnValueOnce(prompted.promise).mockReturnValueOnce(annotated.promise);
    const prompt = connection.dispatch({ type: "view.set-prompt", prompt: "Draft text" });
    const note = connection.dispatch({ type: "annotation.note", annotationId: "annotation", note: "Draft note" });
    assert.equal(connection.getState().prompts["draft:project"], "Draft text");
    assert.equal(connection.getState().annotations["draft:project"][0].note, "Draft note");
    bridge.emit({ revision: 1, patches: [{ path: ["currentId"], value: "other" }] });
    assert.equal(connection.getState().prompts["draft:project"], "Draft text");
    assert.equal(connection.getState().prompts.other, undefined);
    assert.deepEqual(bridge.request.mock.calls[2][0], { type: "annotation.note", taskId: "draft:project", annotationId: "annotation", note: "Draft note" });
    prompted.resolve({ ok: false, message: "Rejected" });
    await prompt;
    assert.equal(connection.getState().prompts["draft:project"], undefined);
    assert.equal(connection.getState().annotations["draft:project"][0].note, "Draft note", "settling one text field leaves the other pending edit visible");
    annotated.resolve({ ok: false, message: "Rejected" });
    await note;
    assert.equal(connection.getState().annotations["draft:project"][0].note, "");
    assert.equal(connection.getState().actionError, null);
  } finally {
    connection.dispose();
  }
});

test("failed and abandoned text requests cannot erase newer edits or contaminate a reconnect", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  const initial = { ...emptyWorkspaceState(), prompts: { "draft:": "Saved" } };
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: initial }); return { ok: true }; });
  try {
    await connection.start();
    const old = Promise.withResolvers<WorkspaceCommandResult>();
    const recent = Promise.withResolvers<WorkspaceCommandResult>();
    bridge.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const first = connection.dispatch({ type: "view.set-prompt", prompt: "Older" });
    const second = connection.dispatch({ type: "view.set-prompt", prompt: "Newest" });
    old.reject(new Error("Old request lost"));
    await first;
    assert.equal(connection.getState().prompts["draft:"], "Newest");
    assert.equal(connection.getState().actionError, "Old request lost");
    connection.dispose();
    bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: initial }); return { ok: true }; });
    await connection.start();
    assert.equal(connection.getState().prompts["draft:"], "Saved");
    recent.reject(new Error("Abandoned connection"));
    await second;
    assert.equal(connection.getState().prompts["draft:"], "Saved");
    assert.equal(connection.getState().actionError, null);
  } finally {
    connection.dispose();
  }
});

test("only supported text edits are projected locally and search edits stay with their find target", async () => {
  const bridge = transport();
  const connection = createWorkspaceConnection();
  const initial = {
    ...emptyWorkspaceState(), currentId: "thread", threads: [task("thread"), task("other")],
    jump: { query: "", index: 0 }, find: { target: { kind: "thread" as const, taskId: "thread" }, query: "", index: 0, focus: 0 },
  };
  bridge.request.mockImplementationOnce(async () => { bridge.emit({ revision: 0, state: initial }); return { ok: true }; });
  try {
    await connection.start();
    const pending = Promise.withResolvers<WorkspaceCommandResult>();
    bridge.request.mockReturnValue(pending.promise);
    const requests = [
      connection.dispatch({ type: "task.rename", taskId: "thread", title: "Renamed" }),
      connection.dispatch({ type: "worktree.menu-search", list: "threads", query: "worktree query" }),
      connection.dispatch({ type: "view.find-query", query: "find query" }),
      connection.dispatch({ type: "view.jump-query", query: "jump query" }),
    ];
    assert.equal(connection.getState().threads[0].title, "Renamed");
    assert.equal(connection.getState().worktreeMenuSearch.threads, "worktree query");
    assert.equal(connection.getState().find!.query, "find query");
    assert.equal(connection.getState().jump!.query, "jump query");
    requests.push(connection.dispatch({ type: "task.new" }));
    requests.push(connection.dispatch({ type: "annotation.add", quote: "No local id" }));
    assert.equal(connection.getState().currentId, "thread");
    assert.deepEqual(connection.getState().annotations, {});
    bridge.emit({ revision: 1, patches: [
      { path: ["currentId"], value: "other" },
      { path: ["find"], value: { target: { kind: "thread", taskId: "other" }, query: "other query", index: 0, focus: 0 } },
    ] });
    assert.equal(connection.getState().find!.query, "other query");
    pending.resolve({ ok: false, message: "Refused" });
    await Promise.all(requests);
  } finally {
    connection.dispose();
  }
});
