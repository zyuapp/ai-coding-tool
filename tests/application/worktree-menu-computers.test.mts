import assert from "node:assert/strict";
import { test } from "vitest";
import { routeInput, type PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { WORKTREE_MENU } from "../../src/application/worktree-menu.ts";
import type { ManagedWorktree } from "../../src/domain/worktree.ts";
import { effectOf, heldWorktree, projected, required, task, workspace, PROJECT } from "./workspace-reducer-fixtures.mts";

const first = heldWorktree();
const second = heldWorktree("wt2");
const managed: ManagedWorktree[] = [first, second].map((item) => ({ id: item.id, root: item.root, repository: PROJECT.root, branch: `feature/${item.id}`, status: { changedFiles: 2, comparison: null } }));

/** A paired computer showing a thread that shares a checkout with another of its threads. */
function linux(overrides: Partial<WorkspaceState> = {}): PairedComputer {
  const state = projected({
    currentId: "review",
    worktrees: [first, second],
    managedWorktrees: managed,
    threads: [task("review", { title: "Review login", projectId: PROJECT.id, worktreeId: first.id }), task("build", { title: "Build login", projectId: PROJECT.id, worktreeId: first.id }), task("payment", { title: "Fix invoice rounding", projectId: PROJECT.id, worktreeId: second.id })],
    ...overrides,
  });
  return { id: "linux", name: "linux", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1, state };
}

function showing(computer: PairedComputer, overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  const state = workspace(overrides);
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: [computer], active: computer.id } };
}

test("the location menu of a paired computer's thread lists that computer's threads and checkouts when this window opens it", () => {
  const closed = required(deriveView(showing(linux())).worktreeMenu);
  assert.equal(closed.count, 2);
  assert.deepEqual(closed.threads, [], "nothing is listed until the menu opens");
  const open = required(deriveView(showing(linux(), { openMenu: WORKTREE_MENU })).worktreeMenu);
  assert.equal(open.count, 2);
  assert.deepEqual(open.threads.map((thread) => thread.id), ["review", "build"]);
  assert.deepEqual(open.destinations.map((item) => ({ id: item.id, detail: item.detail })), [{ id: "wt2", detail: "feature/wt2" }]);
  assert.deepEqual(open.destinations[0]?.command, { type: "task.move-worktree", taskId: "review", destination: { kind: "worktree", id: "wt2" } });
  assert.equal(open.deleteRoot, first.root);
  assert.equal(open.canDelete, true);
});

test("the search typed here narrows the other computer's lists, and its listing wait and error show here", () => {
  const searched = required(deriveView(showing(linux(), { openMenu: WORKTREE_MENU, worktreeMenuSearch: { threads: "BUILD", destinations: "invoice" } })).worktreeMenu);
  assert.equal(searched.count, 2);
  assert.deepEqual(searched.threads.map((thread) => thread.id), ["build"]);
  assert.deepEqual(searched.destinations, []);
  assert.deepEqual(searched.search, { threads: "BUILD", destinations: "invoice" });
  const waiting = required(deriveView(showing(linux({ managedWorktrees: null, worktreeManagementLoading: true, worktreeManagementError: "Git is missing" }), { openMenu: WORKTREE_MENU })).worktreeMenu);
  assert.equal(waiting.loading, true);
  assert.equal(waiting.error, "Git is missing");
  assert.deepEqual(waiting.destinations.map((item) => [item.detail, item.disabled]), [["Branch not loaded", true]]);
});

test("opening the destinations asks the computer holding the checkout to list its worktrees, while the menu and the search stay here", () => {
  const state = showing(linux(), { openMenu: WORKTREE_MENU, worktreeMenuSearch: { threads: "", destinations: "old" } });
  assert.deepEqual(routeInput(state, { type: "view.set-menu", menu: WORKTREE_MENU }), { kind: "local" });
  assert.deepEqual(routeInput(state, { type: "worktree.menu-open", list: "threads" }), { kind: "local" });
  assert.deepEqual(routeInput(state, { type: "worktree.menu-search", list: "destinations", query: "pay" }), { kind: "local" });
  const opened = reduce(state, { type: "worktree.menu-open", list: "destinations" });
  assert.deepEqual(effectOf(opened, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "worktree.menu-open", list: "destinations" }] });
  assert.ok(opened.effects.every((effect) => effect.type !== "list-worktrees"), "this computer's checkouts are not the ones offered");
  assert.equal(opened.state.worktreeManagementLoading, false);
  assert.equal(opened.state.worktreeMenuSearch.destinations, "", "the search starts over here, where it is typed");
});

test("moving and deleting act on the computer holding the checkout", () => {
  const state = showing(linux());
  const move = routeInput(state, { type: "task.move-worktree", taskId: "review", destination: { kind: "worktree", id: "wt2" } });
  assert.equal(move.kind, "computer");
  const byRoot = routeInput(state, { type: "worktree.delete", root: first.root });
  assert.equal(byRoot.kind === "computer" && byRoot.computer.id, "linux");
  const byThread = routeInput(state, { type: "worktree.delete", taskId: "review" });
  assert.equal(byThread.kind === "computer" && byThread.computer.id, "linux");
  const shown = routeInput(state, { type: "worktree.delete" });
  assert.equal(shown.kind === "computer" && shown.computer.id, "linux");
  const own = { ...state, worktrees: [heldWorktree("mine")] };
  assert.deepEqual(routeInput(own, { type: "worktree.delete", root: heldWorktree("mine").root }), { kind: "local" }, "a checkout of this computer's is deleted here");
  const confirming = reduce(state, { type: "worktree.confirm-delete", root: first.root });
  assert.deepEqual(confirming.effects, []);
  assert.equal(deriveView(confirming.state).worktreeDeleteConfirmation?.root, first.root, "the confirmation names the other computer's checkout");
});
