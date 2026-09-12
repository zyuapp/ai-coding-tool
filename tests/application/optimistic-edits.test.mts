import assert from "node:assert/strict";
import { test } from "vitest";
import { applyOptimisticEdits, optimisticEdit, type OptimisticEdit } from "../../src/application/optimistic-edits.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

function edit(state = emptyWorkspaceState(), input: WorkspaceInput, revision?: number): OptimisticEdit {
  const pending = optimisticEdit(state, input);
  assert.ok(pending);
  return revision === undefined ? pending : { ...pending, revision };
}

test("an edit names the field it was typed in, and commands without local text are not held", () => {
  const state = workspace({ currentId: "thread", threads: [task("thread")] });
  const typed = edit(state, { type: "view.set-prompt", prompt: "hello" });
  assert.deepEqual(typed.input, { type: "view.set-prompt", taskId: "thread", prompt: "hello" });
  assert.equal(typed.key, edit(workspace({ currentId: "other" }), { type: "view.set-prompt", taskId: "thread", prompt: "later" }).key);
  assert.notEqual(typed.key, edit(state, { type: "task.rename", taskId: "thread", title: "Renamed" }).key);
  assert.equal(optimisticEdit(state, { type: "task.new" }), null);
  assert.equal(optimisticEdit(state, { type: "view.find-query", query: "no find bar" }), null, "a search edit needs a target to belong to");
});

test("pending edits are replayed over the authoritative state, oldest first", () => {
  const state = workspace({ currentId: "thread", threads: [task("thread")] });
  const view = applyOptimisticEdits(state, [
    edit(state, { type: "view.set-prompt", prompt: "draft" }),
    edit(state, { type: "task.rename", taskId: "thread", title: "Renamed" }),
  ], 0);
  assert.equal(view.state.prompts.thread, "draft");
  assert.equal(view.state.threads[0].title, "Renamed");
  assert.equal(view.edits.length, 2);
  assert.equal(applyOptimisticEdits(state, [], 0).state, state, "nothing pending draws the authoritative state itself");
});

test("an edit is held until the revision carrying it arrives, whatever order replies and revisions take", () => {
  const state = workspace({ prompts: { "draft:": "Saved" } });
  const older = edit(state, { type: "view.set-prompt", prompt: "Older" }, 7);
  const newer = edit(state, { type: "view.set-prompt", taskId: "draft:other", prompt: "Newer" }, 5);
  const unacknowledged = edit(state, { type: "task.rename", taskId: "thread", title: "Renamed" });

  const pending = applyOptimisticEdits(state, [older, newer, unacknowledged], 4);
  assert.equal(pending.state.prompts["draft:"], "Older");
  assert.deepEqual(pending.edits, [older, newer, unacknowledged]);

  const partly = applyOptimisticEdits(state, [older, newer, unacknowledged], 6);
  assert.deepEqual(partly.edits, [older, unacknowledged], "a later reply cannot keep an edit the workspace has already published");
  assert.equal(partly.state.prompts["draft:"], "Older");

  const settled = applyOptimisticEdits({ ...state, prompts: { "draft:": "Older" } }, partly.edits, 7);
  assert.deepEqual(settled.edits, [unacknowledged], "the edit drops out once the authoritative text catches up");
  assert.equal(settled.state.prompts["draft:"], "Older");
});

test("an edit the state already reads is held without being replayed over it", () => {
  const state = workspace({
    currentId: "thread", threads: [task("thread", { title: "Renamed", titleByUser: true })],
    prompts: { thread: "typed" }, jump: { query: "jump", index: 0 },
    annotations: { thread: [{ id: "annotation", quote: "quoted", note: "noted" }] },
    worktreeMenuSearch: { threads: "worktree", destinations: "" },
    find: { target: { kind: "thread", taskId: "thread" }, query: "needle", index: 0, focus: 0 },
  });
  const caught = [
    edit(state, { type: "view.set-prompt", prompt: "typed" }),
    edit(state, { type: "task.rename", taskId: "thread", title: "Renamed" }),
    edit(state, { type: "annotation.note", annotationId: "annotation", note: "noted" }),
    edit(state, { type: "worktree.menu-search", list: "threads", query: "worktree" }),
    edit(state, { type: "view.find-query", query: "needle" }),
    edit(state, { type: "view.jump-query", query: "jump" }),
  ];
  for (const pending of caught) {
    const view = applyOptimisticEdits(state, [pending], 0);
    assert.equal(view.state, state, `${pending.input.type} redrew a state that already reads the same`);
    assert.deepEqual(view.edits, [pending], "the edit is still held until its own revision arrives");
  }
  assert.notEqual(applyOptimisticEdits(state, [edit(state, { type: "view.set-prompt", prompt: "typing on" })], 0).state, state);
});

test("a search edit is held but not drawn once the find bar points somewhere else", () => {
  const searching = workspace({
    currentId: "thread", threads: [task("thread")],
    find: { target: { kind: "thread", taskId: "thread" }, query: "", index: 0, focus: 0 },
  });
  const typed = edit(searching, { type: "view.find-query", query: "needle" });
  assert.equal(applyOptimisticEdits(searching, [typed], 0).state.find!.query, "needle");

  const moved = { ...searching, find: { ...searching.find!, target: { kind: "terminal" as const, terminalId: "shell" }, query: "elsewhere" } };
  const invalidated = applyOptimisticEdits(moved, [typed], 0);
  assert.equal(invalidated.state.find!.query, "elsewhere");
  assert.deepEqual(invalidated.edits, [typed], "the edit stays pending until its own revision settles it");

  const closed = applyOptimisticEdits({ ...searching, find: null }, [typed], 0);
  assert.equal(closed.state.find, null);
  assert.deepEqual(closed.edits, [typed]);

  const returned = applyOptimisticEdits(searching, invalidated.edits, 0);
  assert.equal(returned.state.find!.query, "needle", "the same target draws the edit again");
});
