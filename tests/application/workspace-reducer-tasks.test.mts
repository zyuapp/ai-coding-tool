import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { ChangedFilesResult } from "../../src/contracts/ipc.ts";
import type { TaskStoreData } from "../../src/domain/task.ts";
import { task, workspace, activeRun, automation, effectAt, heldWorktree, inside, PROJECT, required, run, running, send } from "./workspace-reducer-fixtures.mts";

test("archiving a task retires its automation and cancels a run still going", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    automations: [automation("task-a"), automation("task-b")],
    activeRuns: { "task-b": activeRun("task-b", "run-b") },
  });

  const archived = reduce(state, { type: "task.archive", taskId: "task-a" });
  assert.deepEqual(archived.effects, [{ type: "automation.delete", taskId: "task-a" }]);
  assert.ok(archived.state.tasks[0].archivedAt);

  const running = reduce(state, { type: "task.archive", taskId: "task-b" });
  assert.deepEqual(running.effects, [
    { type: "automation.delete", taskId: "task-b" },
    { type: "send-run-command", command: { type: "cancel", taskId: "task-b", runId: "run-b" } },
  ]);
  assert.ok(running.state.tasks[1].archivedAt);
});

test("restoring an archived task returns it to the sidebar and leaves its automation retired", () => {
  const archived = reduce(workspace({ tasks: [task("task-a")], automations: [automation("task-a")] }), { type: "task.archive", taskId: "task-a" });
  const restored = reduce(archived.state, { type: "task.restore", taskId: "task-a" });

  assert.equal(restored.state.tasks[0].archivedAt, undefined);
  assert.deepEqual(restored.effects, []);
  assert.deepEqual(deriveView(restored.state).orderedTasks.map((item) => item.id), ["task-a"]);
  assert.equal(reduce(restored.state, { type: "task.restore", taskId: "task-a" }).state, restored.state);
});

test("clearing the archive deletes every archived task at once", () => {
  const state = workspace({ tasks: [task("kept"), task("archived-a", { archivedAt: 5 }), task("archived-b", { archivedAt: 6 })], currentId: "archived-a" });
  const cleared = reduce(state, { type: "task.clear-archive" });

  assert.deepEqual(cleared.state.tasks.map((item) => item.id), ["kept"]);
  assert.equal(cleared.state.currentId, null);
  assert.equal(reduce(cleared.state, { type: "task.clear-archive" }).state, cleared.state);
});

test("a load drops archived tasks past the retention window and keeps the rest", () => {
  const day = 86_400_000;
  const loaded = reduce(workspace(), {
    type: "store.loaded",
    data: {
      version: 2,
      projects: [],
      worktrees: [],
      lastFolder: null,
      tasks: [
        task("kept"),
        task("recent", { archivedAt: Date.now() - 4 * day }),
        task("expired", { archivedAt: Date.now() - 6 * day }),
      ],
    },
  });

  assert.deepEqual(loaded.state.tasks.map((item) => item.id), ["kept", "recent"]);
  assert.deepEqual(deriveView(loaded.state).archivedTasks.map((item) => item.id), ["recent"]);
});

/** The store is read while the window is already up, so everything below happens before it answers. */
const STORE_ANSWER: TaskStoreData = { version: 2, tasks: [task("stored")], projects: [], worktrees: [], lastFolder: null };

test("a load lands a session that has gone nowhere on the newest thread", () => {
  const loaded = reduce(workspace(), { type: "store.loaded", data: STORE_ANSWER });

  assert.equal(loaded.state.currentId, "stored");
  assert.deepEqual(loaded.state.history, ["stored"]);
});

test("nothing is empty until the store has answered, whatever it answers", () => {
  assert.equal(workspace().restored, false);
  assert.equal(reduce(workspace(), { type: "store.loaded", data: STORE_ANSWER }).state.restored, true);
  assert.equal(reduce(workspace(), { type: "store.absent" }).state.restored, true);
  assert.equal(reduce(workspace(), { type: "store.failed", message: "unreadable" }).state.restored, true);
});

test("threads this build cannot read are counted until the notice is closed", () => {
  const loaded = reduce(workspace(), { type: "store.loaded", data: STORE_ANSWER, hiddenTasks: 49 });
  assert.equal(loaded.state.hiddenTasks, 49);
  assert.equal(deriveView(loaded.state).hiddenTasks, 49);

  const dismissed = reduce(loaded.state, { type: "view.dismiss-hidden-tasks" });
  assert.equal(dismissed.state.hiddenTasks, 0);
  assert.deepEqual(dismissed.state.tasks, loaded.state.tasks, "closing the notice keeps the threads that did load");
});

test("a draft typed before the load is still there, and still where it was typed, after", () => {
  const typed = run(workspace(), [
    { type: "view.set-prompt", prompt: "the first message after a restart" },
    { type: "annotation.add", quote: "your earlier words", note: "this bit" },
  ]);
  const key = Object.keys(typed.prompts)[0];

  const arrived = reduce(typed, { type: "store.loaded", data: STORE_ANSWER }).state;
  assert.equal(arrived.prompts[key], "the first message after a restart");
  assert.equal(arrived.annotations[key].length, 1);
  assert.equal(arrived.currentId, null, "the store never moves a session that has already been typed into");
});

test("a send waiting on its workspace survives the load, and still starts its run", () => {
  const typed = run(workspace(), [{ type: "view.set-prompt", prompt: "the first message after a restart" }]);
  const sending = reduce(typed, { type: "task.send", attachments: [] });
  const { pendingId } = effectAt(sending, "resolve-run-workspace");

  const arrived = reduce(sending.state, { type: "store.loaded", data: STORE_ANSWER });
  assert.deepEqual(Object.keys(arrived.state.pendingRuns), [pendingId], "the run on its way out is not the store's to drop");

  const started = reduce(arrived.state, { type: "run.resolved", pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.equal(effect.type, "start-run");
  assert.equal(effect.command.prompt, "the first message after a restart");
});

test("a run already going survives the load, and keeps reporting into its thread", () => {
  const sending = reduce(run(workspace(), [{ type: "view.set-prompt", prompt: "Look at the annotations" }]), { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { taskId, runId } = effectAt(started, "start-run").command;

  const arrived = reduce(started.state, { type: "store.loaded", data: STORE_ANSWER }).state;
  assert.ok(arrived.tasks.some((item) => item.id === taskId), "a thread started before the answer is not in it");
  assert.equal(arrived.activeRuns[taskId]?.runId, runId);

  const replied = reduce(arrived, { type: "run.event", event: { type: "assistant.delta", taskId, runId, sequence: 1, messageId: "reply", text: "On it" } });
  assert.equal(required(required(replied.state.tasks.find((item) => item.id === taskId)).messages.at(-1)).text, "On it");
});

test("changed files from a superseded run never overwrite the snapshot", () => {
  const state = workspace({ tasks: [task("task-a")], lastRunIds: { "task-a": "run-2" } });
  const stale = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", runId: "run-1", result: { status: "available", files: ["stale"], branch: "old", baseline: null, additions: 0, deletions: 0 } });
  assert.equal(stale.state.tasks, state.tasks);
  assert.equal(required(stale.state.environments["workspace-1"]).status, "available", "the checkout itself is worth recording whoever asked");

  const current = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", runId: "run-2", result: { status: "available", files: ["fresh"], branch: "main", baseline: null, additions: 1, deletions: 0 } });
  assert.deepEqual(current.state.tasks[0].lastChangeSnapshot.files, ["fresh"]);
});

test("an unchanged environment refresh does not rewrite the workspace or task", () => {
  const result: ChangedFilesResult = { status: "available", files: [" M src/App.tsx"], branch: "main", baseline: "origin/main", additions: 2, deletions: 1 };
  const state = workspace({
    tasks: [task("task-a", { lastChangeSnapshot: { files: [...result.files], capturedAt: 1 } })],
    environments: { "workspace-1": result },
  });

  const unchanged = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", result: { ...result, files: [...result.files] } });
  assert.equal(unchanged.state, state);

  const movedBranch = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", result: { ...result, branch: "feature" } });
  assert.notEqual(movedBranch.state, state);
  assert.equal(movedBranch.state.tasks, state.tasks, "environment details do not rewrite an unchanged task snapshot");
  const environment = required(movedBranch.state.environments["workspace-1"]);
  assert.equal(environment.status, "available");
  assert.equal(environment.status === "available" && environment.branch, "feature");
});

const READ: ChangedFilesResult = { status: "available", files: [" M src/App.tsx"], branch: "main", baseline: "origin/main", additions: 2, deletions: 1 };
const CHECKOUT = required(PROJECT.workspaceId);

test("a checkout answering never takes the answer off the checkout on screen", () => {
  const tree = heldWorktree("wt1");
  const state = workspace({
    projects: [PROJECT],
    ...inside(tree, [task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-1") },
    lastRunIds: { "task-b": "run-1" },
  });
  const both = { ...state, tasks: [task("task-a", { projectId: PROJECT.id }), ...state.tasks] };

  const seeded = reduce(both, { type: "environment.updated", workspaceId: CHECKOUT, result: READ });
  assert.equal(deriveView(seeded.state).environment, READ);

  const elsewhere = reduce(seeded.state, {
    type: "environment.updated",
    workspaceId: tree.workspaceId,
    taskId: "task-b",
    runId: "run-1",
    result: { status: "available", files: [], branch: "feature", baseline: "origin/main", additions: 0, deletions: 0 },
  });

  const view = deriveView(elsewhere.state);
  assert.equal(view.workspaceId, CHECKOUT);
  assert.equal(view.environment, READ, "the thread in front keeps the answer about its own checkout");
  assert.equal(required(elsewhere.state.environments[tree.workspaceId]).status, "available", "and the other checkout has its own");
});

test("a thread returned to shows what Git last said while the new read runs", () => {
  const tree = heldWorktree("wt1");
  const state = workspace({
    projects: [PROJECT],
    ...inside(tree, [task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
  });
  const both = { ...state, tasks: [task("task-a", { projectId: PROJECT.id }), ...state.tasks] };
  const read = reduce(both, { type: "environment.updated", workspaceId: CHECKOUT, result: READ }).state;

  const away = reduce(read, { type: "task.select", taskId: "task-b" }).state;
  assert.equal(deriveView(away).environment, null, "a checkout nothing has read yet says nothing");

  const back = reduce(away, { type: "task.select", taskId: "task-a" }).state;
  assert.equal(deriveView(back).environment, READ);
});

test("an answer is forgotten once its checkout is gone", () => {
  const tree = heldWorktree("wt1");
  const state = workspace({
    projects: [PROJECT],
    ...inside(tree, [task("task-a", { projectId: PROJECT.id })]),
    currentId: "task-a",
    environments: { [tree.workspaceId]: READ },
  });

  const deleted = reduce(state, {
    type: "worktree.deleted",
    worktreeId: tree.id,
    root: tree.root,
    snapshot: { commit: null, shortCommit: null, ref: null },
  });
  assert.equal(deleted.state.environments[tree.workspaceId], undefined);
});

test("an answer about a checkout the app no longer has is not kept", () => {
  const state = workspace({
    projects: [PROJECT],
    tasks: [task("task-a", { projectId: PROJECT.id })],
    currentId: "task-a",
    environments: { "worktree-gone": READ },
  });

  const read = reduce(state, { type: "environment.updated", workspaceId: CHECKOUT, result: READ });
  assert.deepEqual(Object.keys(read.state.environments), [CHECKOUT]);
});
