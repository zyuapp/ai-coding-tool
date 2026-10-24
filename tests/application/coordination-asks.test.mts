import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinatorAskRefusal, reduce, WORKSPACE_ERRORS } from "../../src/application/workspace-reducer.ts";
import { DECISIONS_FULL, NO_COORDINATOR, NO_MEMORY, OUTSIDE_COORDINATION } from "../../src/application/workspace-reducer/errors.ts";
import { MAX_OPEN_DECISIONS } from "../../src/domain/coordination.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

const LEAD_THERE = { threadId: "lead-there", title: "Lead", computer: "Laptop" };
const team = () => workspace({ threads: [task("lead", { role: "coordinator" }), task("worker", { parentId: "lead" }), task("alone"), task("far", { remoteLead: LEAD_THERE })] });

test("a report answers with what it recorded, and a refused one changes nothing and shows the user nothing", () => {
  const state = team();
  const refused = reduce(state, { type: "coordination.reported", taskId: "alone", state: "done", summary: "Done" });
  assert.deepEqual(refused.result, { ok: true, answer: { recorded: false, reason: NO_COORDINATOR } });
  assert.equal(refused.state.threads, state.threads);
  assert.equal(refused.state.actionError, null);
  assert.deepEqual(refused.effects, []);
  assert.deepEqual(reduce(state, { type: "coordination.reported", taskId: "ghost", state: "done", summary: "Done" }).result, { ok: true, answer: { recorded: false, reason: NO_COORDINATOR } });
  for (const taskId of ["worker", "far"]) {
    const reported = reduce(state, { type: "coordination.reported", taskId, state: "blocked", summary: "Needs a token" });
    assert.deepEqual(reported.result, { ok: true, answer: { recorded: true } }, taskId);
    assert.equal(reported.state.threads.find((thread) => thread.id === taskId)?.report?.summary, "Needs a token");
  }
});

test("a decision answers with what it raised, or why it raised nothing", () => {
  const waiting = Array.from({ length: MAX_OPEN_DECISIONS }, (_, index) => ({ id: `d${index}`, question: `Q${index}?`, options: [], raisedAt: index }));
  const state = workspace({ threads: [...team().threads, task("full", { parentId: "lead", decisions: waiting })] });
  const raise = (taskId: string) => reduce(state, { type: "coordination.decision-raised", taskId, request: { question: "Ship it?", options: [] } });
  assert.deepEqual(raise("alone").result, { ok: true, answer: { recorded: false, reason: OUTSIDE_COORDINATION } });
  assert.deepEqual(raise("ghost").result, { ok: true, answer: { recorded: false, reason: OUTSIDE_COORDINATION } });
  assert.deepEqual(raise("full").result, { ok: true, answer: { recorded: false, reason: DECISIONS_FULL } });
  assert.equal(raise("full").state.threads, state.threads);
  assert.equal(raise("full").state.actionError, null);
  for (const taskId of ["lead", "worker", "far"]) assert.deepEqual(raise(taskId).result, { ok: true, answer: { recorded: true } }, taskId);
});

test("a coordinator's own memory change answers with the note it saved, while the user's edits still refuse on screen", () => {
  const notes = [{ id: "n1", text: "Use Sonnet for docs", at: 1 }];
  const state = workspace({ threads: [task("lead", { role: "coordinator", memory: { notes, revision: 2, heard: 2 } }), task("solo")] });
  assert.deepEqual(reduce(state, { type: "coordination.remembered", taskId: "lead", change: { kind: "remember", text: "Keep updates short" } }).result, { ok: true, answer: { recorded: true, noteId: "n3" } });
  assert.deepEqual(reduce(state, { type: "coordination.remembered", taskId: "lead", change: { kind: "purpose", purpose: "" } }).result, { ok: true, answer: { recorded: true } }, "a change that alters nothing is still no refusal");
  assert.deepEqual(reduce(state, { type: "coordination.remembered", taskId: "solo", change: { kind: "remember", text: "Remember this" } }).result, { ok: true, answer: { recorded: false, reason: NO_MEMORY } });
  const missing = reduce(state, { type: "coordination.remembered", taskId: "lead", change: { kind: "forget", noteId: "n9" } });
  assert.deepEqual(missing.result, { ok: true, answer: { recorded: false, reason: "No note has the ID n9." } });
  assert.equal(missing.state.threads, state.threads);
  assert.equal(missing.state.actionError, null);
  const byUser = reduce(state, { type: "memory.forget", taskId: "lead", noteId: "n9" });
  assert.deepEqual(byUser.result, { ok: false, message: "No note has the ID n9." });
  assert.equal(byUser.state.actionError, "No note has the ID n9.");
});

test("one rule says what no thread asks of a coordinator, here or on a paired computer", () => {
  const lead = task("lead", { role: "coordinator" });
  const held = task("held", { worktreeId: "wt1" });
  const plain = task("plain");
  const move = (kind: "new" | "local") => ({ type: "task.move-worktree" as const, destination: { kind } });
  const role = (value: "coordinator" | "reviewer" | null) => ({ type: "task.set-role" as const, role: value });
  assert.equal(coordinatorAskRefusal(lead, move("new"), false), WORKSPACE_ERRORS.worktreeCoordinator);
  assert.equal(coordinatorAskRefusal(lead, move("local"), false), undefined, "back to the project checkout is always allowed");
  assert.equal(coordinatorAskRefusal(task("gone", { role: "coordinator", archivedAt: 1 }), move("new"), false), undefined, "an archived coordinator is one no longer");
  assert.equal(coordinatorAskRefusal(plain, move("new"), false), undefined);
  assert.equal(coordinatorAskRefusal(lead, role(null), false), WORKSPACE_ERRORS.coordinatorRole);
  assert.equal(coordinatorAskRefusal(lead, role("reviewer"), false), WORKSPACE_ERRORS.coordinatorRole);
  assert.equal(coordinatorAskRefusal(held, role("coordinator"), false), WORKSPACE_ERRORS.worktreeCoordinatorRole);
  assert.equal(coordinatorAskRefusal(plain, role("coordinator"), true), WORKSPACE_ERRORS.worktreeCoordinatorRole, "nor one whose worktree is on its way");
  assert.equal(coordinatorAskRefusal(plain, role("coordinator"), false), undefined);
  assert.equal(coordinatorAskRefusal(held, role("reviewer"), false), undefined);

  const sender = { threadId: "other", title: "Other", computer: "Linux" };
  const signed = reduce(workspace({ threads: [held] }), { type: "task.set-role", taskId: "held", role: "coordinator", sender });
  assert.deepEqual(signed.result, { ok: false, message: WORKSPACE_ERRORS.worktreeCoordinatorRole }, "a signed ask from a paired computer is refused by the same rule");
});
