import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, WORKSPACE_ERRORS } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { Project } from "../../src/domain/project.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { Worktree } from "../../src/domain/worktree.ts";
import { task, workspace, activeRun, effectAt, required, run, running, PROJECT, projected, madeWorktree, heldWorktree, inside, send } from "./workspace-reducer-fixtures.mts";

test("asking for a worktree from the panel moves the thread there and then", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const asked = reduce(state, { type: "task.set-worktree", worktree: true });
  assert.deepEqual(asked.effects, [{ type: "create-worktree", taskId: "task-a", projectRoot: "/repo" }]);
  assert.equal(deriveView(asked.state).location.kind, "creating", "the row says the checkout is being made rather than claiming the thread is still local");

  const worktree = madeWorktree();
  const made = reduce(asked.state, { type: "worktree.created", taskId: "task-a", worktree });
  assert.deepEqual(made.state.worktrees, [{ ...worktree, projectId: PROJECT.id }], "the checkout gets a record of its own, filed under the project it was cut from");
  assert.equal(made.state.threads[0].worktreeId, worktree.id);
  assert.equal(deriveView(made.state).location.kind, "worktree");
  assert.match(required(made.state.threads[0]?.messages.at(-1)).text, /Moved into a worktree at \/worktrees\/repo-wt1/);
});

test("the move confirmation opens on what the move would cost, and only where it costs something", () => {
  const held = heldWorktree();
  const local = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const asked = reduce(local, { type: "view.move-worktree", worktree: true });
  assert.deepEqual(asked.effects, [], "nothing moves until the question is answered");
  assert.deepEqual(deriveView(asked.state).worktreeMove, { worktree: true, changes: 0, others: 0 });

  const cancelled = reduce(asked.state, { type: "view.move-worktree", worktree: null });
  assert.equal(deriveView(cancelled.state).worktreeMove, null);
  assert.deepEqual(cancelled.effects, []);

  const confirmed = reduce(asked.state, { type: "task.set-worktree", worktree: true });
  assert.equal(deriveView(confirmed.state).worktreeMove, null, "the question closes with the move it asked about");
  assert.deepEqual(confirmed.effects, [{ type: "create-worktree", taskId: "task-a", projectRoot: "/repo" }]);

  const clean = projected({ ...inside(held, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });
  const straight = reduce(clean, { type: "view.move-worktree", worktree: false });
  assert.equal(deriveView(straight.state).worktreeMove, null, "a clean thread walking back has nothing to lose, so it just goes");
  assert.deepEqual(straight.effects.map((effect) => effect.type), ["release-worktree"], "it goes straight to handing the checkout back");

  const holding = projected({
    ...inside(held, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
    environments: { [held.workspaceId]: { status: "available", files: ["src/app.ts"], branch: "main", baseline: null, additions: 1, deletions: 0 } },
  });
  const returning = reduce(holding, { type: "view.move-worktree", worktree: false });
  assert.deepEqual(deriveView(returning.state).worktreeMove, { worktree: false, changes: 1, others: 1 }, "the dialog is told what it commits and who stays behind");
  assert.equal(returning.state.threads[0].worktreeId, held.id, "the thread stays put while the question is up");
});

test("a thread already in a worktree is not given a second one", () => {
  const state = projected({ ...inside(heldWorktree(), [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  assert.deepEqual(reduce(state, { type: "task.set-worktree", worktree: true }).effects, []);
});

test("a thread whose worktree is still being made will not ask for a second one", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const asked = reduce(state, { type: "task.set-worktree", worktree: true });
  assert.deepEqual(asked.state.creatingWorktrees, ["task-a"]);

  const again = reduce(asked.state, { type: "task.set-worktree", worktree: true });
  assert.deepEqual(again.effects, [], "the second ask makes no second checkout for the first one to orphan");
  assert.equal(again.state.actionError, WORKSPACE_ERRORS.worktreeCreating);

  const view = deriveView(asked.state);
  assert.equal(view.waitingOn, "worktree", "the transcript says what the thread is waiting on");
  assert.equal(view.runningThreadIds.has("task-a"), true, "the sidebar marks the thread as working");

  const made = reduce(asked.state, { type: "worktree.created", taskId: "task-a", worktree: madeWorktree() });
  assert.deepEqual(made.state.creatingWorktrees, []);
  assert.equal(deriveView(made.state).waitingOn, null);
});

test("a send waits for the checkout a thread is being given rather than running in the project", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });
  const asked = reduce(state, { type: "task.set-worktree", worktree: true });

  const typed = run(asked.state, [{ type: "view.set-prompt", prompt: "Keep going" }]);
  const sent = reduce(typed, { type: "task.send", attachments: [] });

  assert.deepEqual(sent.effects, [], "nothing starts in the checkout the thread is walking out of");
  assert.equal(sent.state.actionError, WORKSPACE_ERRORS.worktreeCreating);
});

test("a worktree that could not be made leaves the thread where it was", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const failed = run(state, [
    { type: "task.set-worktree", worktree: true },
    { type: "worktree.failed", taskId: "task-a", message: "Git is not installed or is not on the PATH." },
  ]);

  assert.equal(failed.threads[0].worktreeId, undefined);
  assert.equal(failed.actionError, "Git is not installed or is not on the PATH.");
  assert.deepEqual(failed.creatingWorktrees, [], "a failure lets the thread ask again");
  assert.equal(deriveView(failed).location.kind, "local");
});

test("a thread another thread starts in a worktree gets one on its first run", () => {
  const drafted = projected();

  const sending = reduce(drafted, { type: "task.send", text: "Refactor the loader", project: PROJECT.id, worktree: true });
  const request = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(request.createWorktree, { projectRoot: "/repo", carryChanges: false }, "a thread with no history has nothing to carry");
  assert.equal(deriveView(sending.state).waitingOn, null, "a thread another agent started is not the draft the user is looking at");

  const worktree = madeWorktree();
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: request.pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
    worktree,
  });
  const start = effectAt(started, "start-run");
  assert.equal(start.command.workspaceId, worktree.workspaceId, "the run happens in the worktree, not the project");
  assert.equal(start.command.forkContinuation, undefined, "a thread with no session has nothing to fork");
  assert.equal(started.state.threads[0].worktreeId, worktree.id);
  assert.deepEqual(started.state.worktrees.map((item) => item.root), [worktree.root]);
});

test("a draft sent into a worktree of its own says so until the run starts", () => {
  const drafted = run(projected(), [
    { type: "task.set-worktree", worktree: true },
    { type: "view.set-prompt", prompt: "Refactor the loader" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const pending = Object.values(sending.state.pendingRuns)[0];
  assert.equal(required(pending).creatingWorktree, true);
  assert.equal(deriveView(sending.state).waitingOn, "worktree", "the composer says the checkout is being made rather than looking like Enter did nothing");

  const worktree = madeWorktree();
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: effectAt(sending, "resolve-run-workspace").pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
    worktree,
  });
  assert.equal(deriveView(started.state).waitingOn, null, "the run itself takes over saying the thread is working");
  assert.deepEqual(started.state.prompts, {});
});

test("a thread already talking carries its work into the worktree and forks its session", () => {
  const existing = task("task-a", {
    projectId: PROJECT.id,
    continuation: { provider: "claude", value: "session-1" },
    continuationStatus: "available",
  });
  const state = projected({ threads: [existing], currentId: "task-a", prompts: { "task-a": "Keep going" } });

  const worktree = madeWorktree();
  const moved = run(state, [
    { type: "task.set-worktree", worktree: true },
    { type: "worktree.created", taskId: "task-a", worktree },
  ]);
  const talking = send(moved, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  assert.deepEqual(talking.request.workspace, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });
  const started = effectAt(talking, "start-run");
  assert.equal(started.command.forkContinuation, true, "the session branches rather than moving, so nothing writes it from two places");
  assert.equal(required(started.command.continuation).value, "session-1");
  const notes = talking.state.threads[0].messages.filter((message) => message.kind === "system");
  assert.equal(notes.length, 1, "moving says so once, when it happens");
  const note = required(notes[0]);
  assert.match(note.text, /Moved into a worktree at \/worktrees\/repo-wt1/);
  assert.match(required(note.detail), /Detached at abcdef1/);
});

test("a thread that stays in its worktree reuses it and stops forking", () => {
  const worktree = heldWorktree();
  const existing = task("task-a", {
    projectId: PROJECT.id,
    worktreeEnteredAt: 3,
    continuation: { provider: "claude", value: "session-2" },
    continuationStatus: "available",
  });
  const state = projected({ ...inside(worktree, [existing]), currentId: "task-a", prompts: { "task-a": "And again" } });

  const again = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  assert.deepEqual(again.request, {
    type: "resolve-run-workspace",
    pendingId: again.request.pendingId,
    picker: false,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
  }, "an existing worktree is resolved as a worktree, never made again");
  assert.equal(effectAt(again, "start-run").command.forkContinuation, undefined, "the thread is already there, so its session just continues");
  assert.equal(again.state.threads[0].messages.filter((message) => message.kind === "system").length, 0);
});

test("switching back to local hands the worktree back, and the thread records where the work went", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });
  assert.deepEqual(leaving.effects, [{
    type: "release-worktree",
    taskId: "task-a",
    worktreeId: "wt1",
    root: worktree.root,
    title: "task-a",
  }]);
  assert.ok(leaving.state.threads[0].worktreeId, "the thread keeps its worktree until the snapshot lands");
  assert.deepEqual(leaving.state.releasingWorktrees, ["task-a"]);
  assert.equal(deriveView(leaving.state).location.kind, "releasing", "the row says the checkout is going rather than claiming the thread still works in it");
  assert.equal(deriveView(leaving.state).waitingOn, "worktree-release");

  const released = reduce(leaving.state, {
    type: "worktree.released",
    taskId: "task-a",
    snapshot: { commit: "1234567890", shortCommit: "1234567", ref: "refs/aicodingtool/wt1" },
  });
  assert.equal(released.state.threads[0].worktreeId, undefined);
  assert.equal(deriveView(released.state).location.kind, "local");
  const note = required(released.state.threads[0]?.messages.at(-1));
  assert.match(note.text, /committed as 1234567, and the worktree was removed/);
  assert.match(required(note.detail), /git show refs\/aicodingtool\/wt1/);
});

test("a checkout that lands after its thread is archived stays with that thread", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });
  const archived = reduce(state, { type: "task.archive", taskId: "task-a" }).state;

  const created = reduce(archived, { type: "worktree.created", taskId: "task-a", worktree: madeWorktree() });

  assert.deepEqual(created.effects, []);
  assert.deepEqual(created.state.worktrees.map((worktree) => worktree.root), ["/worktrees/repo-wt1"]);
  assert.equal(created.state.threads[0].worktreeId, "wt1");
});

test("archiving a thread cancels its run and keeps its checkout", () => {
  const worktree = { ...madeWorktree(), projectId: PROJECT.id };
  const state = projected({
    threads: [task("task-a", { projectId: PROJECT.id, worktreeId: worktree.id })],
    worktrees: [worktree],
    currentId: "task-a",
    activeRuns: { "task-a": activeRun("task-a", "run-a", { sequence: 1 }) },
  });

  const archived = reduce(state, { type: "task.archive", taskId: "task-a" });

  assert.deepEqual(archived.effects.filter((effect) => effect.type !== "browser.show" && effect.type !== "focus-window"), [
    { type: "send-run-command", command: { type: "cancel", taskId: "task-a", runId: "run-a" } },
  ]);
  assert.equal(archived.state.threads[0].worktreeId, worktree.id);
  assert.deepEqual(archived.state.worktrees, [worktree]);
});

test("archiving one thread leaves a checkout another thread is still working in alone", () => {
  const worktree = { ...madeWorktree(), projectId: PROJECT.id };
  const state = projected({
    threads: [
      task("task-a", { projectId: PROJECT.id, worktreeId: worktree.id }),
      task("task-b", { projectId: PROJECT.id, worktreeId: worktree.id }),
    ],
    worktrees: [worktree],
  });

  const archived = reduce(state, { type: "task.archive", taskId: "task-a" });

  assert.deepEqual(archived.effects, [], "the checkout goes back only when the last thread lets go");
  assert.deepEqual(archived.state.worktrees, [worktree]);
});

test("clearing the archive leaves its worktree for manual management", () => {
  const worktree = { ...madeWorktree(), projectId: PROJECT.id };
  const state = projected({
    threads: [
      task("kept", { projectId: PROJECT.id }),
      task("archived-a", { projectId: PROJECT.id, archivedAt: 5, worktreeId: worktree.id }),
      task("archived-b", { projectId: PROJECT.id, archivedAt: 6 }),
    ],
    worktrees: [worktree],
  });

  const cleared = reduce(state, { type: "task.clear-archive" });

  assert.deepEqual(cleared.effects, []);
  assert.deepEqual(cleared.state.threads.map((item) => item.id), ["kept"]);
  assert.deepEqual(cleared.state.worktrees, [worktree]);
});

test("neither switching back nor deleting happens under a running thread", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]),
    currentId: "task-a",
    activeRuns: { "task-a": activeRun("task-a", "run-a", { sequence: 1 }) },
  });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });
  assert.deepEqual(leaving.effects, []);
  assert.equal(leaving.state.actionError, WORKSPACE_ERRORS.worktreeRunning);

  const deleting = reduce(state, { type: "worktree.delete" });
  assert.deepEqual(deleting.effects, []);
  assert.equal(deleting.state.actionError, WORKSPACE_ERRORS.worktreeRunning);
});

test("manually deleting a worktree snapshots it and puts the thread back on the project", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  const deleting = reduce(state, { type: "worktree.delete" });
  assert.deepEqual(deleting.effects, [{ type: "delete-worktree", worktreeId: worktree.id, root: worktree.root, title: "repo-wt1" }]);

  const deleted = reduce(deleting.state, {
    type: "worktree.deleted",
    worktreeId: worktree.id,
    root: worktree.root,
    snapshot: { commit: "1234567890", shortCommit: "1234567", ref: "refs/aicodingtool/wt1" },
  });
  assert.equal(deleted.state.threads[0].worktreeId, undefined);
  assert.match(required(deleted.state.threads[0]?.messages.at(-1)).text, /Worktree deleted/);
  assert.match(required(deleted.state.worktreeManagementNotice), /git show refs\/aicodingtool\/wt1/);
});

test("a thread started in a checkout the project already has runs there, and none is made", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]) });

  const sending = reduce(state, { type: "task.send", text: "Take the other half", worktreeId: worktree.id });

  const request = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(sending.effects, [{
    type: "resolve-run-workspace",
    pendingId: request.pendingId,
    picker: false,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
  }], "the checkout is entered as it stands, never cut again");

  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: request.pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
  });
  const fresh = required(started.state.threads.find((item) => item.id !== "task-a"));
  assert.equal(fresh.worktreeId, worktree.id);
  assert.equal(fresh.projectId, PROJECT.id, "the checkout says which project the thread belongs to");
  assert.deepEqual(started.state.worktrees.map((item) => item.id), [worktree.id], "and the checkout is still the one record it was");
  assert.ok(required(started.state.worktrees[0]).lastUsedAt > worktree.lastUsedAt, "touched by the run that just happened in it");
});

test("a checkout picked for the next thread is what the send reads, and asking for a new one drops it", () => {
  const worktree = heldWorktree();
  const state = projected({ worktrees: [worktree], draftProjectId: null });

  const picked = reduce(state, { type: "task.new", worktreeId: worktree.id });
  assert.equal(picked.state.draftWorktreeId, worktree.id);
  assert.equal(picked.state.draftProjectId, PROJECT.id, "picking a checkout picks the project it was cut from");
  assert.equal(deriveView(picked.state).draftWorktreeName, "repo-wt1");

  const typed = run(picked.state, [{ type: "view.set-prompt", prompt: "Alongside the others" }]);
  const sending = reduce(typed, { type: "task.send", attachments: [] });
  assert.deepEqual(effectAt(sending, "resolve-run-workspace").workspace, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  const asked = reduce(picked.state, { type: "task.set-worktree", worktree: true });
  assert.equal(asked.state.draftWorktreeId, null, "asking for a checkout of its own is asking for a new one");
});

test("a checkout that is not there, or is another project's, refuses the send rather than guessing", () => {
  const worktree = heldWorktree();
  const other: Project = { id: "project-b", root: "/other", workspaceId: "workspace-b" };
  const state = projected({ worktrees: [worktree], projects: [PROJECT, other] });

  const missing = reduce(state, { type: "task.send", text: "Go", worktreeId: "wt-nothing" });
  assert.deepEqual(missing.effects, []);
  assert.equal(missing.state.actionError, WORKSPACE_ERRORS.worktreeMissing);

  const elsewhere = reduce(state, { type: "task.send", text: "Go", worktreeId: worktree.id, project: other.id });
  assert.deepEqual(elsewhere.effects, []);
  assert.equal(elsewhere.state.actionError, WORKSPACE_ERRORS.worktreeElsewhere);
});

test("threads sharing a checkout each fork their own session the first time they run in it", () => {
  const worktree = heldWorktree();
  const resolution: WorkspaceRecord = { id: worktree.workspaceId, kind: "worktree", root: worktree.root };
  const talking = task("task-b", {
    projectId: PROJECT.id,
    worktreeId: worktree.id,
    continuation: { provider: "claude", value: "session-b" },
    continuationStatus: "available",
  });
  const state = projected({
    worktrees: [worktree],
    threads: [task("task-a", { projectId: PROJECT.id, worktreeId: worktree.id, worktreeEnteredAt: 3 }), talking],
    currentId: "task-b",
    prompts: { "task-b": "Your turn" },
  });

  const first = send(state, resolution);
  assert.equal(effectAt(first, "start-run").command.forkContinuation, true, "a thread that has yet to run in there forks rather than resuming");
  assert.ok(required(first.state.threads.find((item) => item.id === "task-b")).worktreeEnteredAt);
  assert.equal(required(first.state.threads.find((item) => item.id === "task-a")).worktreeEnteredAt, 3, "and says nothing about the thread already in there");
});

test("leaving a checkout another thread is still in takes only this thread's claim", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
  });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });

  assert.deepEqual(leaving.effects, [], "nothing is committed or removed while a thread is still working in there");
  assert.equal(leaving.state.threads[0].worktreeId, undefined);
  assert.equal(leaving.state.threads[1].worktreeId, worktree.id);
  assert.deepEqual(leaving.state.worktrees, [worktree]);
  assert.match(required(leaving.state.threads[0]?.messages.at(-1)).text, /other threads are still working in it/);

  const last = reduce(leaving.state, { type: "task.set-worktree", taskId: "task-b", worktree: false });
  assert.deepEqual(last.effects, [{ type: "release-worktree", taskId: "task-b", worktreeId: worktree.id, root: worktree.root, title: "task-b" }], "the last claim to go hands the directory back");
});

test("archiving every thread in a checkout keeps the checkout", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]) });

  const first = reduce(state, { type: "task.archive", taskId: "task-a" });
  assert.deepEqual(first.effects.filter((effect) => effect.type === "release-worktree"), [], "a thread is still working in there");

  const last = reduce(first.state, { type: "task.archive", taskId: "task-b" });
  assert.deepEqual(last.effects.filter((effect) => effect.type === "release-worktree"), []);
  assert.deepEqual(last.state.worktrees, [worktree]);
});

test("a checkout that goes takes the draft pointed at it back to the project", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  const picked = reduce(state, { type: "task.new", worktreeId: worktree.id });
  assert.equal(picked.state.draftWorktreeId, worktree.id);

  const released = run(picked.state, [
    { type: "task.set-worktree", taskId: "task-a", worktree: false },
    { type: "worktree.released", taskId: "task-a", snapshot: { commit: null, shortCommit: null, ref: null } },
  ]);

  assert.equal(released.draftWorktreeId, null, "a draft is never left waiting on a directory that is gone");
  assert.deepEqual(reduce(released, { type: "task.send", text: "Go" }).state.actionError, null);
});

test("deleting a checkout puts every thread in it back on the project", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
  });

  const deleting = reduce(state, { type: "worktree.delete" });
  assert.deepEqual(deleting.effects, [{ type: "delete-worktree", worktreeId: worktree.id, root: worktree.root, title: "repo-wt1" }]);

  const deleted = reduce(deleting.state, {
    type: "worktree.deleted",
    worktreeId: worktree.id,
    root: worktree.root,
    snapshot: { commit: null, shortCommit: null, ref: null },
  });
  assert.deepEqual(deleted.state.threads.map((item) => item.worktreeId), [undefined, undefined], "the directory is gone for all of them, not just the one that asked");
  assert.deepEqual(deleted.state.worktrees, []);
  assert.match(required(deleted.state.threads[1]?.messages.at(-1)).text, /Worktree deleted/);
});

test("a thread working in a checkout stops anything else in it from being deleted under it", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-b", { sequence: 1 }) },
  });

  const deleting = reduce(state, { type: "worktree.delete" });

  assert.deepEqual(deleting.effects, []);
  assert.equal(deleting.state.actionError, WORKSPACE_ERRORS.worktreeRunning);
});

test("the sidebar nests a checkout's threads under it and leaves the project's own alone", () => {
  const worktree = heldWorktree();
  const state = projected({
    worktrees: [worktree],
    threads: [
      task("checkout-later", { projectId: PROJECT.id, worktreeId: worktree.id, sortIndex: 3 }),
      task("checkout-first", { projectId: PROJECT.id, worktreeId: worktree.id, sortIndex: 0 }),
      task("in-project", { projectId: PROJECT.id, sortIndex: 1 }),
      task("archived", { projectId: PROJECT.id, worktreeId: worktree.id, archivedAt: 5 }),
      task("orphan", { projectId: PROJECT.id, worktreeId: "missing-worktree" }),
    ],
  });

  const view = deriveView(state);
  const [group] = view.worktreeGroups;
  assert.ok(group);

  assert.equal(group.worktree.id, worktree.id);
  assert.deepEqual(group.threads.map((item) => item.id), ["checkout-first", "checkout-later"], "the checkout follows the sidebar order without listing archived threads");
  assert.deepEqual([...view.worktreeThreadIds], ["checkout-later", "checkout-first", "archived", "orphan"], "every persisted checkout claim remains marked, including archived and orphaned ones");
});

test("removing a project waits for its worktrees to be deleted manually", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]) });

  const removed = reduce(state, { type: "project.remove", projectId: PROJECT.id });

  assert.deepEqual(removed.effects, []);
  assert.equal(removed.state.actionError, WORKSPACE_ERRORS.projectWorktrees);
  assert.deepEqual(removed.state.projects, [PROJECT]);
});

test("a thread with no project folder has nowhere to put a worktree", () => {
  const state = workspace({ threads: [task("task-a")], currentId: "task-a" });

  const refused = reduce(state, { type: "task.set-worktree", worktree: true });

  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.worktreeProject);
  assert.deepEqual(refused.effects, [], "nothing is made where there is no project to cut it from");
});

test("the panel and the sidebar read a thread's checkout from the same place", () => {
  const worktree = heldWorktree();
  const state = projected({
    worktrees: [worktree],
    threads: [task("task-a", { projectId: PROJECT.id, worktreeId: worktree.id }), task("task-b", { projectId: PROJECT.id })],
    currentId: "task-a",
  });

  const view = deriveView(state);
  assert.deepEqual([...view.worktreeThreadIds], ["task-a"]);
  assert.equal(view.location.kind, "worktree");
  assert.equal(view.location.worktree.root, worktree.root);
  assert.equal(deriveView({ ...state, currentId: "task-b" }).location.kind, "local");
});

test("a thread in a worktree reports that checkout's changes, not the project's", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  const refreshing = reduce(state, { type: "view.refresh-environment" });

  assert.deepEqual(refreshing.effects, [{ type: "refresh-environment", workspaceId: worktree.workspaceId, taskId: "task-a" }]);
});

test("resolving into a worktree never restates where the project itself is", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const worktree = madeWorktree();
  const moved = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root }, worktree);

  assert.deepEqual(moved.state.projects, [PROJECT], "the project keeps its own folder and workspace");
  assert.equal(deriveView(moved.state).folder, "/repo");
});

test("a thread whose worktree is being removed waits instead of asking twice", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]),
    currentId: "task-a",
    prompts: { "task-a": "anything" },
  });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });

  const again = reduce(leaving.state, { type: "task.set-worktree", worktree: false });
  assert.deepEqual(again.effects, [], "the second ask removes no directory the first one is already taking");
  assert.equal(again.state.actionError, WORKSPACE_ERRORS.worktreeReleasing);

  const sending = reduce(leaving.state, { type: "task.send", attachments: [] });
  assert.deepEqual(sending.effects, [], "a run has nowhere settled to start while the folder is going");
  assert.equal(sending.state.actionError, WORKSPACE_ERRORS.worktreeReleasing);

  const deleting = reduce(leaving.state, { type: "worktree.delete", root: worktree.root });
  assert.deepEqual(deleting.effects, []);
  assert.equal(deleting.state.worktreeManagementError, WORKSPACE_ERRORS.worktreeReleasing);
});

test("a worktree that will not come back leaves its thread where it was, with the reason", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });
  const failed = reduce(leaving.state, { type: "worktree.release-failed", taskId: "task-a", message: "Git said no" });

  assert.deepEqual(failed.state.releasingWorktrees, []);
  assert.equal(failed.state.actionError, "Git said no");
  assert.equal(failed.state.threads[0].worktreeId, worktree.id, "the checkout is still there, so the thread is still in it");
  assert.equal(deriveView(failed.state).location.kind, "worktree");
});

test("deleting a checkout from Settings tells every thread standing in it", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })]),
    currentId: "task-a",
    managedWorktrees: [{ id: worktree.id, root: worktree.root, repository: PROJECT.root, branch: null }],
  });

  const deleting = reduce(state, { type: "worktree.delete", root: worktree.root });

  assert.equal(deriveView(deleting.state).location.kind, "releasing");
  assert.equal(deriveView(deleting.state).waitingOn, "worktree-release");
  assert.deepEqual([...deriveView(deleting.state).runningThreadIds].sort(), ["task-a", "task-b"], "both threads wait on the ground being taken from under them");

  const gone = reduce(deleting.state, {
    type: "worktree.deleted",
    worktreeId: worktree.id,
    root: worktree.root,
    snapshot: { commit: null, shortCommit: null, ref: null },
  });
  assert.equal(deriveView(gone.state).location.kind, "local");
  assert.deepEqual(gone.state.releasingWorktrees, []);
});
