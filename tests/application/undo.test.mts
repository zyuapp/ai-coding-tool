import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { applyMobilePatch, diffMobileView, projectMobileView } from "../../src/application/mobile-projection.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import { isMobileCommand } from "../../src/contracts/mobile.ts";
import { isExternalCommand, isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { UNDO_SUBJECT, type Toast } from "../../src/domain/toast.ts";
import { heldWorktree, PROJECT, task, workspace } from "./workspace-reducer-fixtures.mts";

function undoOf(state: WorkspaceState): Toast | undefined {
  return state.toasts.find((toast) => toast.subject === UNDO_SUBJECT);
}

/** Presses the Undo that is up, the way a toast's button dispatches it. */
function takeBack(state: WorkspaceState) {
  const command = undoOf(state)?.action?.command;
  assert.ok(command, "an Undo is up");
  return reduce(state, command as WorkspaceInput);
}

test("archiving a thread offers an Undo that restores it and then goes", () => {
  const archived = reduce(workspace({ threads: [task("a", { title: "Fix the parser" })] }), { type: "task.archive", taskId: "a" });
  const undo = undoOf(archived.state);
  assert.equal(undo?.title, "Archived “Fix the parser”");
  assert.deepEqual(undo?.action, { label: "Undo", command: { type: "task.restore", taskId: "a" } });
  assert.ok(archived.effects.some((effect) => effect.type === "schedule-toast-dismissal" && effect.id === undo?.id), "it leaves on its own");

  const restored = takeBack(archived.state);
  assert.equal(restored.state.threads[0]!.archivedAt, undefined);
  assert.equal(undoOf(restored.state), undefined);
  assert.equal(undoOf(reduce(restored.state, { type: "task.archive", taskId: "missing" }).state), undefined, "nothing archived, nothing offered");
});

test("restoring from the archive list leaves an Undo about something else up", () => {
  let state = workspace({ threads: [task("a"), task("b", { archivedAt: 1 })] });
  state = reduce(state, { type: "task.archive", taskId: "a" }).state;
  state = reduce(state, { type: "task.restore", taskId: "b" }).state;
  assert.deepEqual(undoOf(state)?.action?.command, { type: "task.restore", taskId: "a" });
});

test("a dismissal's Undo puts back the verdict and findings it filed away", () => {
  const finding = { id: "f", headline: "Tests are red", key: "red", at: 1 };
  const before = task("a", { title: "Nightly check", outcome: "finished", outcomeUnread: true, findings: [finding], handledIssues: ["old"] });
  const dismissed = reduce(workspace({ threads: [before] }), { type: "task.dismiss", taskId: "a" });
  assert.equal(dismissed.state.threads[0]!.outcome, undefined);
  assert.equal(undoOf(dismissed.state)?.title, "Dismissed “Nightly check”");
  assert.deepEqual(undoOf(dismissed.state)?.action?.command, { type: "task.undismiss", taskIds: ["a"] });

  const undone = takeBack(dismissed.state);
  assert.deepEqual(undone.state.threads[0], before);
  assert.equal(undoOf(undone.state), undefined);
  assert.deepEqual(undone.state.filedAttention, {});
  assert.equal(reduce(undone.state, { type: "task.undismiss", taskIds: ["a"] }).state, undone.state, "a second Undo has nothing to put back");
});

test("a dismissal's Undo leaves a thread alone that has had something new to say since", () => {
  const dismissed = reduce(workspace({ threads: [task("a", { outcome: "finished" })] }), { type: "task.dismiss", taskId: "a" });
  const later = { ...dismissed.state, threads: [{ ...dismissed.state.threads[0]!, outcome: "failed" as const }] };
  assert.equal(takeBack(later).state.threads[0]!.outcome, "failed");
});

test("dismissing a row with nothing to file away offers no Undo", () => {
  const dismissed = reduce(workspace({ threads: [task("a")] }), { type: "task.dismiss", taskId: "a" });
  assert.equal(undoOf(dismissed.state), undefined);
});

test("Dismiss all offers one Undo that names how many rows went, and puts every one back", () => {
  const state = workspace({ threads: [task("a", { outcome: "finished" }), task("b", { outcome: "failed" }), task("c")] });
  const dismissed = reduce(state, { type: "task.dismiss-all" });
  assert.equal(undoOf(dismissed.state)?.title, "Dismissed 2 threads");
  const undone = takeBack(dismissed.state);
  assert.deepEqual(undone.state.threads.map((thread) => thread.outcome), ["finished", "failed", undefined]);
  assert.equal(undoOf(reduce(state, { type: "task.dismiss-all", localOnly: true }).state), undefined, "a dismissal carried here from another computer is offered back there");
});

test("a newer Undo takes the place of the one before it", () => {
  let state = workspace({ threads: [task("a"), task("b", { outcome: "finished" })] });
  state = reduce(state, { type: "task.archive", taskId: "a" }).state;
  state = reduce(state, { type: "task.dismiss", taskId: "b" }).state;
  assert.deepEqual(state.toasts.map((toast) => toast.action?.command.type), ["task.undismiss"]);
});

test("a move to a checkout that stands offers its way back, and taking it back offers nothing more", () => {
  const worktree = { ...heldWorktree("wt1"), name: "Spike" };
  const state = workspace({ projects: [PROJECT], worktrees: [worktree], threads: [task("a", { projectId: PROJECT.id })] });
  const moved = reduce(state, { type: "task.move-worktree", taskId: "a", destination: { kind: "worktree", id: "wt1" } });
  assert.equal(moved.state.threads[0]!.worktreeId, "wt1");
  assert.equal(undoOf(moved.state)?.title, "Moved to Spike");
  assert.deepEqual(undoOf(moved.state)?.action?.command, { type: "task.move-worktree", taskId: "a", destination: { kind: "local" } });

  const back = takeBack(moved.state);
  assert.equal(back.state.threads[0]!.worktreeId, undefined);
  assert.equal(undoOf(back.state), undefined);

  const leaving = reduce(moved.state, { type: "task.move-worktree", taskId: "a", destination: { kind: "local" } });
  assert.equal(undoOf(leaving.state), undefined, "a checkout no other thread works in has no way back");
  const fresh = reduce(state, { type: "task.move-worktree", taskId: "a", destination: { kind: "new" } });
  assert.equal(undoOf(fresh.state), undefined, "nor does a new one");
  const own = reduce(state, { type: "task.move-worktree", taskId: "a", destination: { kind: "worktree", id: "wt1" }, then: "go on" });
  assert.equal(undoOf(own.state), undefined, "a thread moving itself is offered nothing");
});

test("the Undo for a paired computer's thread is offered here and sent there", () => {
  const remote = workspace({ threads: [task("r", { title: "Remote work", outcome: "finished" })] });
  const computer: PairedComputer = { id: "linux", name: "linux", host: "linux.ts.net", status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: remote };
  const state = workspace({ computers: { ...workspace().computers, paired: [computer] } });

  const archived = reduce(state, { type: "task.archive", taskId: "r" });
  assert.equal(undoOf(archived.state)?.title, "Archived “Remote work”");
  const restore = takeBack(archived.state);
  assert.deepEqual(restore.effects.find((effect) => effect.type === "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "task.restore", taskId: "r" }] });

  const dismissed = reduce(state, { type: "task.dismiss", taskId: "r" });
  const undismiss = takeBack(dismissed.state);
  assert.deepEqual(undismiss.effects.find((effect) => effect.type === "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "task.undismiss", taskIds: ["r"] }] });

  const old = { ...state, computers: { ...state.computers, paired: [{ ...computer, capabilities: COMPUTER_CAPABILITIES.filter((name) => !name.startsWith("command:task.undismiss")) }] } };
  assert.equal(undoOf(reduce(old, { type: "task.dismiss", taskId: "r" }).state), undefined, "a computer that cannot take it back is offered no Undo");
});

test("the phone is shown the desktop's Undo and may send it, and nothing else", () => {
  const archived = reduce(workspace({ threads: [task("a", { title: "Fix the parser" })] }), { type: "task.archive", taskId: "a" }).state;
  const before = projectMobileView(workspace({ threads: [task("a")] }), 1);
  const after = projectMobileView(archived, 1);
  assert.deepEqual(after.undo, { id: undoOf(archived)!.id, title: "Archived “Fix the parser”", command: { type: "task.restore", taskId: "a" } });
  const patch = diffMobileView(before, after);
  assert.deepEqual(patch?.undo, after.undo);
  assert.deepEqual(applyMobilePatch(before, patch!)?.undo, after.undo);
  assert.equal(diffMobileView(after, projectMobileView(takeBack(archived).state, 1))?.undo, null);
  assert.equal(projectMobileView(reduce(workspace(), { type: "app.launched", version: "2.0" }).state, 1).undo, null, "other toasts stay on the desktop");

  assert.ok(isMobileCommand({ type: "task.undismiss", taskIds: ["a", "b"] }));
  assert.ok(isWorkspaceViewInput({ type: "task.undismiss", taskIds: ["a"] }));
  assert.equal(isMobileCommand({ type: "task.undismiss", taskIds: "a" }), false);
  assert.equal(isMobileCommand({ type: "task.undismiss", taskIds: [""] }), false);
  assert.equal(isWorkspaceViewInput({ type: "task.undismiss" }), false);
  assert.equal(isExternalCommand({ type: "task.undismiss", taskIds: ["a"] }), false, "an agent never sends it");
});
