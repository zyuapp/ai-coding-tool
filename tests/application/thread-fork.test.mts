import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { orderTasks } from "../../src/application/task-order.ts";
import { forkTitle, type Task } from "../../src/domain/task.ts";
import { activeRun } from "./workspace-reducer-fixtures.mts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function effectOf<Type extends WorkspaceEffect["type"]>(transition: WorkspaceTransition, type: Type): Extract<WorkspaceEffect, { type: Type }> {
  const effect = transition.effects.find((candidate) => candidate.type === type);
  assert.ok(effect, `expected effect ${type}`);
  return effect as Extract<WorkspaceEffect, { type: Type }>;
}

/** The thread the fork was made from, and the copy it produced, which is the one that is new. */
function forked(before: WorkspaceState, after: WorkspaceState, sourceId: string) {
  const known = new Set(before.tasks.map((item) => item.id));
  const source = after.tasks.find((item) => item.id === sourceId);
  const fork = after.tasks.find((item) => !known.has(item.id));
  assert.ok(source && fork, "expected the source thread and one copy of it");
  return { source, fork };
}

test("a fork carries the conversation and sits under the thread it was copied from", () => {
  const source = task("first", {
    title: "Fix the login",
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "autonomous",
    model: "opus",
    effort: "high",
    sortIndex: 0,
    messages: [{ id: "m1", kind: "user", text: "Have a look", at: 5 }],
    continuation: { provider: "claude", value: "session-1" },
    continuationStatus: "available",
    outcome: "finished",
    outcomeUnread: true,
    findings: [{ id: "f1", headline: "Something", at: 6 }],
  });
  const other = task("second", { projectId: "project-1", sortIndex: 1 });
  const before = workspace({ tasks: [source, other], currentId: "first" });
  const state = reduce(before, { type: "task.fork" }).state;
  const { fork } = forked(before, state, "first");

  assert.equal(fork.title, "Fix the login (fork)");
  assert.deepEqual(fork.messages, source.messages, "the copy starts from the same conversation");
  assert.equal(fork.projectId, "project-1");
  assert.equal(fork.executionPolicy, "autonomous");
  assert.equal(fork.model, "opus");
  assert.equal(fork.effort, "high");
  assert.deepEqual(fork.continuation, { provider: "claude", value: "session-1" });
  assert.equal(fork.inheritedContinuation, true);
  assert.equal(fork.outcome, undefined, "what the source thread's runs concluded stays with it");
  assert.equal(fork.findings, undefined, "what the source thread's runs found stays with it");
  assert.equal(fork.worktreeId, undefined);
  assert.equal(state.currentId, fork.id, "the copy is opened");
  assert.deepEqual(orderTasks(state.tasks).map((item) => item.id), ["first", fork.id, "second"]);
});

test("a fork of a fork is numbered rather than suffixed twice", () => {
  const before = workspace({ tasks: [task("first", { title: "Fix the login" })], currentId: "first" });
  const once = reduce(before, { type: "task.fork" }).state;
  const { fork } = forked(before, once, "first");
  const twice = reduce(once, { type: "task.fork", taskId: fork.id }).state;

  assert.deepEqual(twice.tasks.map((item) => item.title), ["Fix the login", "Fix the login (fork)", "Fix the login (fork 2)"]);
});

test("forkTitle numbers past the names already taken and never stacks its suffix", () => {
  assert.equal(forkTitle("Audit", []), "Audit (fork)");
  assert.equal(forkTitle("Audit", ["Audit (fork)"]), "Audit (fork 2)");
  assert.equal(forkTitle("Audit (fork)", ["Audit (fork)"]), "Audit (fork 2)");
  assert.equal(forkTitle("Audit (fork 2)", ["Audit (fork)", "Audit (fork 2)"]), "Audit (fork 3)");
  assert.equal(forkTitle("x".repeat(80), []).length, 52, "a long name is cut to leave room for the suffix");
});

test("a fork's first run forks the session it inherited, and its next run continues its own", () => {
  const before = workspace({ tasks: [task("first", { continuation: { provider: "claude", value: "session-1" }, continuationStatus: "available" })], currentId: "first" });
  const state = reduce(before, { type: "task.fork" }).state;
  const { fork } = forked(before, state, "first");

  const sending = reduce(run(state, [{ type: "view.set-prompt", taskId: fork.id, prompt: "Try it another way" }]), { type: "task.send", taskId: fork.id });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: effectOf(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const first = effectOf(resolved, "start-run").command;

  assert.equal(first.forkContinuation, true);
  assert.deepEqual(first.continuation, { provider: "claude", value: "session-1" });
  assert.equal(resolved.state.tasks.find((item) => item.id === fork.id)?.inheritedContinuation, true, "a run that has yet to name a session spends nothing");

  const settled = run(resolved.state, [
    { type: "run.event", event: { type: "continuation.updated", taskId: fork.id, runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "session-2" } } },
    { type: "run.event", event: { type: "run.status", taskId: fork.id, runId: first.runId, sequence: 2, status: "succeeded" } },
    { type: "view.set-prompt", taskId: fork.id, prompt: "Again" },
  ]);
  const resending = reduce(settled, { type: "task.send", taskId: fork.id });
  const second = effectOf(reduce(resending.state, { type: "run.resolved", pendingId: effectOf(resending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }), "start-run").command;

  assert.equal("forkContinuation" in second, false);
  assert.deepEqual(second.continuation, { provider: "claude", value: "session-2" });
  assert.equal(settled.tasks.find((item) => item.id === fork.id)?.inheritedContinuation, undefined, "the session it made of its own spends the inheritance");
});

test("a fork whose run dies before it names a session forks the inherited one again", () => {
  const before = workspace({ tasks: [task("first", { continuation: { provider: "claude", value: "session-1" }, continuationStatus: "available" })], currentId: "first" });
  const state = reduce(before, { type: "task.fork" }).state;
  const { fork } = forked(before, state, "first");

  const sending = reduce(run(state, [{ type: "view.set-prompt", taskId: fork.id, prompt: "Try it another way" }]), { type: "task.send", taskId: fork.id });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: effectOf(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const first = effectOf(resolved, "start-run").command;

  const failed = run(resolved.state, [
    { type: "run.event", event: { type: "run.status", taskId: fork.id, runId: first.runId, sequence: 1, status: "failed" } },
    { type: "view.set-prompt", taskId: fork.id, prompt: "Again" },
  ]);
  const resending = reduce(failed, { type: "task.send", taskId: fork.id });
  const second = effectOf(reduce(resending.state, { type: "run.resolved", pendingId: effectOf(resending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }), "start-run").command;

  assert.equal(second.forkContinuation, true, "the copy never writes into the session the source is still using");
  assert.deepEqual(second.continuation, { provider: "claude", value: "session-1" });
});

test("a fork of a thread whose session was lost carries the conversation and starts a fresh one", () => {
  const before = workspace({
    tasks: [task("first", {
      engine: "codex", model: "gpt-5.6-sol",
      messages: [{ id: "m1", kind: "user", text: "Have a look", at: 5 }],
      continuation: { provider: "codex", value: "thread-1" }, continuationStatus: "available",
    })],
    currentId: "first",
    activeRuns: { first: activeRun("first", "run-1") },
  });
  const lost = run(before, [
    { type: "run.event", event: { type: "continuation.lost", taskId: "first", runId: "run-1", sequence: 1 } },
    { type: "run.event", event: { type: "run.status", taskId: "first", runId: "run-1", sequence: 2, status: "failed" } },
  ]);
  assert.equal(lost.tasks[0].continuation, undefined);
  assert.equal(lost.tasks[0].continuationStatus, "invalid");

  const state = reduce(lost, { type: "task.fork" }).state;
  const { fork } = forked(lost, state, "first");
  assert.equal(fork.engine, "codex");
  assert.deepEqual(fork.messages.map((message) => message.text), ["Have a look"]);
  assert.equal(fork.continuation, undefined);
  assert.equal(fork.inheritedContinuation, undefined);

  const sending = reduce(run(state, [{ type: "view.set-prompt", taskId: fork.id, prompt: "Keep going" }]), { type: "task.send", taskId: fork.id });
  const command = effectOf(reduce(sending.state, { type: "run.resolved", pendingId: effectOf(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }), "start-run").command;
  assert.equal(command.engine, "codex");
  assert.equal(command.model, "gpt-5.6-sol");
  assert.equal(command.continuation, undefined, "the copy starts a thread of its own rather than continuing the lost one");
  assert.equal("forkContinuation" in command, false);
});

test("forking into a worktree asks for a checkout of the copy's own", () => {
  const state = workspace({
    tasks: [task("first", { projectId: "project-1" })],
    projects: [{ id: "project-1", root: "/work/api", workspaceId: "workspace-1" }],
    currentId: "first",
  });
  const transition = reduce(state, { type: "task.fork", worktree: true });
  const { fork } = forked(state, transition.state, "first");

  assert.deepEqual(effectOf(transition, "create-worktree"), { type: "create-worktree", taskId: fork.id, projectRoot: "/work/api" });
});
