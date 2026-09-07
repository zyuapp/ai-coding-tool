import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { item, mount } from "../support/renderer-dom.mts";
import type { WorkspaceBridge, WorkspacePatch, WorkspaceUpdate } from "../../src/contracts/workspace-runtime.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import { activeRun, task } from "../application/workspace-reducer-fixtures.mts";

vi.mock("../../src/renderer/task-workspace/workspace-subscriptions.ts", () => ({ useWorkspaceSubscriptions() {} }));
const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");

test("thread handles follow membership, queued work, and project edits when only those inputs change", async () => {
  const previousBridge = window.workspace;
  let listener: ((update: WorkspaceUpdate) => void) | undefined;
  let revision = 0;
  const state = {
    ...emptyWorkspaceState(), restored: true, currentId: "reader", draftProjectId: "project-a",
    projects: [{ id: "project-a", root: "/a", name: "Alpha" }, { id: "project-b", root: "/b", name: "Beta" }],
    threads: [task("reader", { projectId: "project-a" }), task("a", { projectId: "project-a" }), task("b", { projectId: "project-b" })],
  };
  window.workspace = {
    owner: false,
    request: async (input) => { if (!input) listener?.({ revision, state }); return { ok: true, revision }; },
    onUpdate: (next) => { listener = next; return () => { listener = undefined; }; },
    onSurface: () => () => {}, onRequest: () => () => {}, respond() {}, publish() {}, ready() {}, surface() {},
  } satisfies WorkspaceBridge;
  let latest: ReturnType<typeof useTaskWorkspace> | undefined;
  function Harness() { latest = useTaskWorkspace(); return null; }
  const view = await mount(React.createElement(Harness));
  const workspace = { view, get: () => item(latest) };
  const optionsForBothDrafts = () => [workspace.get().threadHandles, workspace.get().threadHandlesFor("b")];
  const publish = async (patches: WorkspacePatch[]) => {
    await act(async () => { item(listener)({ revision: ++revision, patches }); });
  };
  const running = (id: string) => item(workspace.get().threadHandles.find((option) => option.id === id)).running;
  try {
    let previous = optionsForBothDrafts();
    for (const [runs, expected] of [
      [{ a: activeRun("a", "run-a") }, [true, false]],
      [{ b: activeRun("b", "run-b") }, [false, true]],
      [{}, [false, false]],
    ] as const) {
      await publish([{ path: ["activeRuns"], value: runs }]);
      const next = optionsForBothDrafts();
      for (const [index, options] of next.entries()) assert.notEqual(options, previous[index]);
      assert.deepEqual([running("a"), running("b")], expected);
      previous = next;
    }
    await publish([{ path: ["activeRuns"], value: { a: activeRun("a", "run-a"), b: activeRun("b", "run-b") } }]);
    previous = optionsForBothDrafts();
    await publish([{ path: ["activeRuns"], value: { b: activeRun("b", "run-b"), a: activeRun("a", "replacement-run", { sequence: 9 }) } }]);
    for (const [index, options] of optionsForBothDrafts().entries()) assert.equal(options, previous[index], "key order and run identity do not affect handles");

    const pending = { id: "pending", runId: "pending-run", origin: "composer", taskId: "a", text: "go", prompt: "go", attachments: [] };
    await publish([{ path: ["activeRuns"], value: {} }, { path: ["pendingRuns"], value: { pending } }]);
    assert.equal(running("a"), true);
    await publish([{ path: ["pendingRuns"], value: {} }]);
    assert.equal(running("a"), false);
    await publish([{ path: ["queuedMessages"], value: { a: [{ id: "queued", text: "go", prompt: "go", attachments: [] }] } }]);
    assert.equal(running("a"), true);
    await publish([{ path: ["queuedMessages"], value: { a: [] } }]);
    assert.equal(running("a"), false);

    previous = optionsForBothDrafts();
    await publish([{ path: ["projects", 1, "name"], value: "Renamed" }]);
    for (const [index, options] of optionsForBothDrafts().entries()) assert.notEqual(options, previous[index]);
    assert.equal(item(workspace.get().threadHandles.find((option) => option.id === "b")).handle, "renamed/b");
    assert.equal(item(workspace.get().threadHandlesFor("b").find((option) => option.id === "a")).handle, "alpha/a");
    const draft = workspace.get().threadHandlesFor("draft");
    assert.equal(item(draft.find((option) => option.id === "a")).inScope, true);
    await publish([{ path: ["draftProjectId"], value: "project-b" }]);
    const moved = workspace.get().threadHandlesFor("draft");
    assert.notEqual(moved, draft);
    assert.equal(item(moved.find((option) => option.id === "a")).inScope, false);
    assert.equal(item(moved.find((option) => option.id === "b")).inScope, true);
  } finally {
    await workspace.view.unmount();
    if (previousBridge) window.workspace = previousBridge;
    else delete window.workspace;
  }
});
