import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { executeWorkspaceInput, type WorkspaceExecutionHost } from "../../src/application/workspace-execution.ts";
import { answerThreadRequest, releaseThreadWaiters, type ThreadRequestHost } from "../../src/host/thread-requests.ts";
import { isExternalCommand } from "../../src/contracts/workspace-view-input.ts";
import type { ExternalCommand, ThreadCommandResult, ThreadRequest } from "../../src/contracts/threads.ts";
import type { ManagedWorktree } from "../../src/domain/worktree.ts";
import { PROJECT, activeRun, heldWorktree, projected, required, task } from "./workspace-reducer-fixtures.mts";

/** The caller works in wt1 with a run going; wt2 is another checkout of the same project. */
function fixture(): WorkspaceState {
  const first = { ...heldWorktree(), name: "Login redesign" };
  const second = { ...heldWorktree("wt2"), name: "Payment fix" };
  const managed: ManagedWorktree[] = [first, second].map((item) => ({ id: item.id, root: item.root, repository: PROJECT.root, branch: `feature/${item.name.split(" ")[0]!.toLowerCase()}`, status: { changedFiles: 0, comparison: null } }));
  return projected({
    currentId: "other",
    worktrees: [first, second],
    managedWorktrees: managed,
    activeRuns: { caller: activeRun("caller", "run-1") },
    threads: [
      task("caller", { title: "Planner", projectId: PROJECT.id, worktreeId: first.id, worktreeEnteredAt: 3, continuation: { provider: "claude", value: "session" }, continuationStatus: "available" }),
      task("other", { title: "Invoices", projectId: PROJECT.id }),
    ],
  });
}

/** The desktop as far as a move needs it: runs resolve where the reducer says, and start without answering. */
function desktop(initial: WorkspaceState) {
  let state = initial;
  const started: Extract<WorkspaceEffect, { type: "start-run" }>[] = [];
  const waiters: ThreadRequestHost["waiters"] = { current: [] };
  const execution: WorkspaceExecutionHost = {
    state: () => state,
    commit: (next) => { state = next; releaseThreadWaiters(waiters, next); },
    perform: async (effect, dispatch) => {
      if (effect.type === "resolve-run-workspace" && effect.workspace) await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: effect.workspace });
      if (effect.type === "start-run") started.push(effect);
    },
  };
  const host: ThreadRequestHost = {
    state: () => state,
    desktop: {} as ThreadRequestHost["desktop"],
    dispatch: async (input) => { await executeWorkspaceInput(input, execution).completed; },
    execute: (input) => executeWorkspaceInput(input, execution),
    waiters,
  };
  return { host, started, dispatch: (input: WorkspaceInput) => host.dispatch(input) };
}

function move(command: ExternalCommand): ThreadRequest {
  return { type: "thread.request", requestId: "r1", taskId: "caller", op: "command", command };
}

async function answer(host: ThreadRequestHost, request: ThreadRequest) {
  const response = await answerThreadRequest(host, request);
  if (!response.ok) assert.fail(response.message);
  return response.result as ThreadCommandResult;
}

const toWt2 = { kind: "worktree", id: "wt2" } as const;

test("a thread moving itself goes when its turn ends, and its next turn starts in the new checkout", async () => {
  const { host, started, dispatch } = desktop(fixture());
  const result = await answer(host, move({ type: "task.move-worktree", destination: toWt2 }));
  assert.match(result.notice ?? "", /^This thread moves to \/worktrees\/repo-wt2 when this turn ends, .* stays in \/worktrees\/repo-wt1/);
  assert.equal(result.thread?.worktreeId, "wt1", "until the turn ends the app and the agent both still say wt1");
  assert.equal(host.state().threads[0].worktreeId, "wt1");

  await dispatch({ type: "task.send", taskId: "caller", text: "Then run the tests", attachments: [] });
  await dispatch({ type: "run.event", event: { type: "run.status", taskId: "caller", runId: "run-1", sequence: 1, status: "succeeded" } });
  const moved = required(host.state().threads.find((item) => item.id === "caller"));
  assert.equal(moved.worktreeId, "wt2");
  assert.deepEqual(host.state().movesAfterRun, {});
  assert.ok(moved.messages.some((message) => message.text === "Moved to Payment fix. Existing file changes stay in the previous checkout."));
  const next = required(started.at(-1)).command;
  assert.equal(next.workspaceId, heldWorktree("wt2").workspaceId, "the queued message runs in the new checkout");
  assert.equal(next.forkContinuation, true);
});

test("moving another thread by id is immediate, and one that is running refuses as the menu does", async () => {
  const { host } = desktop(fixture());
  const result = await answer(host, move({ type: "task.move-worktree", taskId: "Invoices", destination: toWt2 }));
  assert.equal(result.notice, undefined);
  assert.equal(result.thread?.worktreeId, "wt2");

  const busy = fixture();
  busy.activeRuns.other = activeRun("other", "run-2");
  const refused = await answerThreadRequest(desktop(busy).host, move({ type: "task.move-worktree", taskId: "other", destination: toWt2 }));
  assert.equal(refused.ok, false);
});

test("a move waiting on the run is checked again when the run ends, and taken back by asking to stay", () => {
  const command = { type: "task.move-worktree", taskId: "caller", destination: toWt2, afterRun: true } as const;
  const end = { type: "run.event", event: { type: "run.status", taskId: "caller", runId: "run-1", sequence: 1, status: "cancelled" } } as const;
  const waiting = reduce(fixture(), command).state;
  assert.deepEqual(waiting.movesAfterRun, { caller: toWt2 });

  const gone = reduce({ ...waiting, deletingWorktrees: [heldWorktree("wt2").root] }, end).state;
  assert.equal(gone.threads[0].worktreeId, "wt1");
  assert.equal(gone.threads[0].messages.at(-1)?.tone, "error");

  const stayed = reduce(waiting, { ...command, destination: { kind: "worktree", id: "wt1" } }).state;
  assert.deepEqual(stayed.movesAfterRun, {});
  assert.equal(reduce(stayed, end).state.threads[0].worktreeId, "wt1");

  const unasked = reduce(fixture(), { type: "task.move-worktree", taskId: "caller", destination: toWt2 });
  assert.ok(unasked.state.actionError, "without afterRun a running thread still refuses");
});

test("an agent moves into an existing checkout or back to the project, never into a new one or past the run", () => {
  assert.equal(isExternalCommand({ type: "task.move-worktree", destination: toWt2 }), true);
  assert.equal(isExternalCommand({ type: "task.move-worktree", taskId: "other", destination: { kind: "local" } }), true);
  assert.equal(isExternalCommand({ type: "task.move-worktree", destination: { kind: "new" } }), false);
  assert.equal(isExternalCommand({ type: "task.move-worktree", destination: toWt2, afterRun: true }), false);
});

test("the move menu finds a checkout by the id or folder the thread tools report", () => {
  const state = { ...fixture(), currentId: "other", openMenu: "session:location", activeRuns: {} };
  for (const query of ["wt2", "REPO-WT2"]) {
    const searched = reduce(state, { type: "worktree.menu-search", list: "destinations", query }).state;
    assert.deepEqual(required(deriveView(searched).worktreeMenu).destinations.map((item) => item.id), ["wt2"], query);
  }
});
