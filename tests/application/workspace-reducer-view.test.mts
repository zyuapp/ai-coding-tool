import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { task, workspace, effectAt, run, send } from "./workspace-reducer-fixtures.mts";

test("visiting threads builds a trail that back and forward walk without extending it", () => {
  const state = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(state.history, ["task-a", "task-b", "task-c"]);

  const back = run(state, [{ type: "view.go-back" }, { type: "view.go-back" }]);
  assert.equal(back.currentId, "task-a");
  assert.deepEqual(back.history, ["task-a", "task-b", "task-c"]);
  assert.ok(deriveView(back).canGoForward);
  assert.ok(!deriveView(back).canGoBack);

  const forward = reduce(back, { type: "view.go-forward" }).state;
  assert.equal(forward.currentId, "task-b");
  assert.ok(deriveView(forward).canGoBack);

  assert.equal(reduce(back, { type: "view.go-back" }).state, back, "there is nowhere further back to go");
});

test("history follows wherever the app took the user, not just sidebar clicks", () => {
  const drafted = run(workspace({ tasks: [task("task-a")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.new" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.deepEqual(started.state.history, ["task-a", started.state.currentId]);
  assert.equal(reduce(started.state, { type: "view.go-back" }).state.currentId, "task-a");
});

test("visiting a thread after going back drops the trail ahead of it", () => {
  const walked = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "view.go-back" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(walked.history, ["task-a", "task-c"]);
  assert.equal(walked.currentId, "task-c");
  assert.ok(!deriveView(walked).canGoForward);
});

test("back and forward step over threads that are gone or archived", () => {
  const visited = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);

  const archived = reduce(visited, { type: "task.archive", taskId: "task-b" }).state;
  const back = reduce(archived, { type: "view.go-back" }).state;
  assert.equal(back.currentId, "task-a", "the archived thread in between is skipped");
  assert.equal(reduce(back, { type: "view.go-forward" }).state.currentId, "task-c");

  const emptied = { ...visited, tasks: visited.tasks.filter((item) => item.id !== "task-a") };
  assert.ok(!deriveView({ ...emptied, historyIndex: 1 }).canGoBack, "a thread that no longer exists is nowhere to go");

  const duplicate = workspace({
    tasks: [task("archived", { archivedAt: 0 }), task("shared", { archivedAt: 0 }), task("shared")],
    history: ["archived", "shared"],
    historyIndex: -1,
  });
  assert.equal(reduce(duplicate, { type: "view.go-forward" }).state.currentId, "shared", "an archived entry at time zero is skipped while a live duplicate id stays reachable");
});
