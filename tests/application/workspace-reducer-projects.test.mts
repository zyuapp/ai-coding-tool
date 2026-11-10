import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, WORKSPACE_ERRORS, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { computerEffects } from "../../src/host/computer-effects.ts";
import type { EffectHost } from "../../src/host/effect-host.ts";
import { deriveView } from "../../src/application/workspace-view.ts";
import { RUNNING_PROJECT_ERROR } from "../../src/application/workspace-reducer/errors.ts";
import { task, workspace, activeRun, effectAt, required, run, PROJECT, projected, madeWorktree, heldWorktree, inside, send } from "./workspace-reducer-fixtures.mts";

test("a project with no workspace of its own adopts the one the picker opened for it", () => {
  const state = projected({ projects: [{ ...PROJECT, workspaceId: undefined }], threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const reopened = send(state, { id: "workspace-b", kind: "project", root: "/repo" });

  assert.deepEqual(reopened.state.projects, [{ ...PROJECT, workspaceId: "workspace-b" }]);
});

test("a new thread starts from the branch the draft names, moving the project onto it", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);
  assert.deepEqual(deriveView(drafted).draftBranch, { name: "feature-x", create: false });

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  const request = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(request.checkout, { workspaceId: "workspace-a", branch: "feature-x" }, "without a worktree the project checkout is what moves");
  assert.equal(request.createWorktree, undefined);
});

test("a new thread told to use a worktree detaches it from the branch instead", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "task.set-worktree", worktree: true },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  const request = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(request.createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "feature-x" });
  assert.equal(request.checkout, undefined, "the project checkout is left where it is");
});

test("a branch the repository does not have yet is made before the thread starts from it", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "loader-fix", create: true },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);
  assert.deepEqual(deriveView(drafted).draftBranch, { name: "loader-fix", create: true });

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  const request = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(request.createBranch, { workspaceId: "workspace-a", branch: "loader-fix" });
  assert.deepEqual(request.checkout, { workspaceId: "workspace-a", branch: "loader-fix" }, "the project checkout then moves onto it");

  const worktreed = reduce(run(drafted, [{ type: "task.set-worktree", worktree: true }]), { type: "task.send", attachments: [] });

  const worktreeRequest = effectAt(worktreed, "resolve-run-workspace");
  assert.deepEqual(worktreeRequest.createBranch, { workspaceId: "workspace-a", branch: "loader-fix" });
  assert.deepEqual(worktreeRequest.createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "loader-fix" });
});

test("switching a thread's branch moves the checkout it works in", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const moved = reduce(state, { type: "task.checkout-branch", branch: "feature-x" });
  assert.deepEqual(moved.effects, [{ type: "checkout-branch", workspaceId: "workspace-a", branch: "feature-x" }]);

  const made = reduce(state, { type: "task.checkout-branch", branch: "loader-fix", create: true });
  assert.deepEqual(made.effects, [{ type: "checkout-branch", workspaceId: "workspace-a", branch: "loader-fix", create: true }]);

  const worktree = heldWorktree();
  const inWorktree = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a" });
  assert.deepEqual(
    reduce(inWorktree, { type: "task.checkout-branch", branch: "feature-x" }).effects,
    [{ type: "checkout-branch", workspaceId: "worktree-wt1", branch: "feature-x" }],
    "a thread with a checkout of its own moves that one, never the project's",
  );
});

test("a checkout with a run going is not moved onto another branch", () => {
  const state = projected({
    threads: [task("task-a", { projectId: PROJECT.id }), task("task-b", { projectId: PROJECT.id })],
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-b") },
  });

  const refused = reduce(state, { type: "task.checkout-branch", branch: "feature-x" });
  assert.deepEqual(refused.effects, [], "the ground stays still under the thread that is working");
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.switchRunning);
});

test("a thread that does not exist yet only records the branch it will start from", () => {
  const asked = reduce(projected(), { type: "task.checkout-branch", branch: "feature-x" });

  assert.deepEqual(asked.effects, [], "there is no checkout of its own to move yet");
  assert.deepEqual(deriveView(asked.state).draftBranch, { name: "feature-x", create: false });
});

test("a branch already in the repository is started from without being made", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "view.set-prompt", prompt: "Go" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.equal(effectAt(sending, "resolve-run-workspace").createBranch, undefined);
});

test("the draft answers belong to the thread being started, and reset once it exists", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "task.set-worktree", worktree: true },
    { type: "view.set-prompt", prompt: "Go" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const worktree = madeWorktree();
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: effectAt(sending, "resolve-run-workspace").pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
    worktree,
  });

  assert.equal(started.state.draftBranch, null, "the next new thread starts from a clean slate");
  assert.equal(started.state.draftWorktree, false);

  /** A message to the thread that now exists uses where it already is, not a stale draft. */
  const start = effectAt(started, "start-run");
  const taskId = required(started.state.threads[0]).id;
  const settledRun = run(started.state, [
    { type: "run.event", event: { type: "run.status", taskId, runId: start.command.runId, sequence: 1, status: "succeeded" } },
    { type: "view.set-prompt", taskId, prompt: "More" },
  ]);
  const again = reduce(settledRun, { type: "task.send", attachments: [] });
  const request = effectAt(again, "resolve-run-workspace");
  assert.equal(request.checkout, undefined);
  assert.deepEqual(request.workspace, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });
});

test("starting a thread in another project clears the branch chosen for the last one", () => {
  const drafted = run(projected(), [{ type: "task.set-branch", branch: "feature-x" }]);

  const switched = reduce(drafted, { type: "task.new", projectId: "project-b" });

  assert.equal(switched.state.draftBranch, null, "a branch belongs to the repository it was read from");
  assert.equal(switched.state.draftWorktree, false);
});

test("a thread's second run in its worktree leaves the project row exactly where it was", () => {
  const worktree = heldWorktree();
  const state = projected({
    ...inside(worktree, [task("task-a", { projectId: PROJECT.id, worktreeEnteredAt: 3 })]),
    currentId: "task-a",
    prompts: { "task-a": "Again" },
  });

  const again = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  assert.deepEqual(again.state.projects, [PROJECT], "a run in a worktree never restates where the project is");
  assert.equal(deriveView(again.state).folder, "/repo");
  assert.equal(effectAt(again, "start-run").command.workspaceId, worktree.workspaceId, "and it still happens in the worktree");
});

test("a project that already has a workspace is never moved by a run that resolves elsewhere", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const elsewhere = send(state, { id: "workspace-b", kind: "project", root: "/somewhere-else" });

  assert.deepEqual(elsewhere.state.projects, [PROJECT], "only the picker says where a project lives");
});

test("a thread starting on another branch waits for the runs in that checkout to stop", () => {
  const state = projected({
    threads: [task("task-a", { projectId: PROJECT.id })],
    activeRuns: { "task-a": activeRun("task-a", "run-a", { sequence: 1 }) },
    draftBranch: { name: "feature-x", create: false },
    prompts: { "draft:": "Start here" },
  });

  const refused = reduce(state, { type: "task.send", attachments: [] });

  assert.deepEqual(refused.effects, [], "nothing moves the checkout under a thread that is working in it");
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.checkoutRunning);
  assert.equal(refused.state.threads.length, 1, "and no thread is created for a send that never started");
});

test("a thread starting on another branch in a worktree ignores the runs in the project checkout", () => {
  const state = projected({
    threads: [task("task-a", { projectId: PROJECT.id })],
    activeRuns: { "task-a": activeRun("task-a", "run-a", { sequence: 1 }) },
    draftBranch: { name: "feature-x", create: false },
    draftWorktree: true,
    prompts: { "draft:": "Start here" },
  });

  const sending = reduce(state, { type: "task.send", attachments: [] });

  const request = effectAt(sending, "resolve-run-workspace");
  assert.equal(request.checkout, undefined, "a checkout of its own never moves the project");
  assert.deepEqual(request.createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "feature-x" });
});

test("a thread cannot change where it works while a send is still finding its checkout", () => {
  const worktree = heldWorktree();
  const state = projected({ ...inside(worktree, [task("task-a", { projectId: PROJECT.id })]), currentId: "task-a", prompts: { "task-a": "Go" } });

  const sending = reduce(state, { type: "task.send", attachments: [] });
  const changedMind = reduce(sending.state, { type: "task.set-worktree", worktree: false });

  assert.deepEqual(changedMind.effects, [], "the checkout is not handed back from under a run about to start");
  assert.equal(changedMind.state.actionError, WORKSPACE_ERRORS.worktreeRunning);
  assert.ok(changedMind.state.threads[0].worktreeId);
});

test("an automation waits for a send that is still finding its checkout", () => {
  const state = projected({ threads: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const sending = reduce(state, { type: "task.send", attachments: [] });
  const fired = reduce(sending.state, {
    type: "automation.fired",
    fire: { automationId: "automation-1", taskId: "task-a", runId: "run-b", runNumber: 2, prompt: "Tick" },
  });

  assert.deepEqual(fired.effects, [{ type: "automation.ack", ack: { automationId: "automation-1", runId: "run-b", started: false } }], "two runs would make two checkouts");
});

test("a moved thread joins its new project", () => {
  const state = workspace({
    projects: [{ id: "project-1", root: "/project" }],
    threads: [task("task-a"), task("task-b", { projectId: "project-1" })],
  });

  const moved = reduce(state, { type: "task.move", taskId: "task-a", target: { projectId: "project-1", index: 0 } });
  assert.equal(required(moved.state.threads.find((item) => item.id === "task-a")).projectId, "project-1");
});

test("a folder just opened lands above the ones the user already ordered", () => {
  const state = workspace({ projects: [{ id: "project-1", root: "/one", sortIndex: 0 }] });
  const opened = reduce(state, { type: "project.opened", workspace: { id: "workspace-2", kind: "project", root: "/two" } });

  assert.deepEqual(deriveView(opened.state).projects.map((project) => project.root), ["/two", "/one"]);
});

test("a refused removal is shown on the Projects page, and a removal that goes through clears it", () => {
  const running = projected({ threads: [task("task-a", { projectId: PROJECT.id })], activeRuns: { "task-a": activeRun("task-a", "run-a") } });
  const busy = reduce(running, { type: "project.remove", projectId: PROJECT.id });
  assert.equal(busy.state.actionError, RUNNING_PROJECT_ERROR);
  assert.equal(busy.state.actionErrorPage, "projects");
  assert.deepEqual(busy.state.projects, [PROJECT]);

  const worktree = heldWorktree();
  const checkedOut = reduce(projected({ ...inside(worktree, [task("task-b", { projectId: PROJECT.id })]) }), { type: "project.remove", projectId: PROJECT.id });
  assert.equal(checkedOut.state.actionError, WORKSPACE_ERRORS.projectWorktrees);
  assert.equal(checkedOut.state.actionErrorPage, "projects");

  const removed = reduce({ ...projected(), actionError: RUNNING_PROJECT_ERROR, actionErrorPage: "projects" }, { type: "project.remove", projectId: PROJECT.id });
  assert.deepEqual(removed.state.projects, []);
  assert.equal(removed.state.actionError, null);
  assert.equal(removed.state.actionErrorPage, null);
});

test("a project removal that computer refused is shown on the Projects page, and a later failure takes the page back", async () => {
  const raised: WorkspaceInput[] = [];
  const host = { dispatch: async (input: WorkspaceInput) => { raised.push(input); }, desktop: { sendToComputer: async () => ({ ok: false, message: "Stop the running tasks before removing this project." }) } } as unknown as EffectHost;
  await computerEffects["computer.forward"]({ type: "computer.forward", id: "linux", inputs: [{ type: "project.remove", projectId: "ml" }] }, host);
  assert.deepEqual(raised, [{ type: "action.failed", message: "Stop the running tasks before removing this project.", page: "projects" }]);
  const refused = reduce(workspace(), raised[0]!).state;
  assert.equal(refused.actionError, "Stop the running tasks before removing this project.");
  assert.equal(refused.actionErrorPage, "projects");
  assert.equal(reduce(refused, { type: "action.failed", message: "Refused there" }).state.actionErrorPage, null);
});
