import assert from "node:assert/strict";
import { test } from "vitest";
import { executeWorkspaceInput, type WorkspaceExecutionHost } from "../../src/application/workspace-execution.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { DRAFT_DOCK, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { EMPTY_DIFF } from "../../src/application/workspace-diff.ts";
import { answerThreadRequest, type ThreadRequestHost } from "../../src/renderer/task-workspace/thread-requests.ts";
import { MAX_ATTACHED_FILES, MAX_ATTACHMENTS } from "../../src/domain/conversation.ts";
import { PROJECT, task, workspace } from "./workspace-reducer-fixtures.mts";

function driver(initial: WorkspaceState, perform: WorkspaceExecutionHost["perform"] = async () => {}) {
  let state = initial;
  const execution: WorkspaceExecutionHost = {
    state: () => state,
    commit: (next) => { state = next; },
    perform,
  };
  const host: ThreadRequestHost = {
    state: () => state,
    dispatch: async (input) => { await executeWorkspaceInput(input, execution).completed; },
    execute: (input) => executeWorkspaceInput(input, execution),
    waiters: { current: [] },
  };
  return { ...host, input: (input: WorkspaceInput) => executeWorkspaceInput(input, execution) };
}

test("each rejection is returned even when the same error is already displayed", async () => {
  const host = driver(workspace());
  const first = host.execute({ type: "browser.reload" });
  const second = host.execute({ type: "browser.reload" });
  assert.equal((await first.accepted).ok, false);
  assert.deepEqual(second.accepted, first.accepted);
  assert.deepEqual(await second.completed, first.accepted);
  assert.deepEqual(host.execute({ type: "view.set-prompt", prompt: "hello" }).accepted, { ok: true });
});

test("effect failures belong to their own overlapping command", async () => {
  let fail = () => {};
  const host = driver(workspace(), async (effect) => {
    if (effect.type === "file.open" && effect.path === "/failure") {
      await new Promise<void>((resolve) => { fail = resolve; });
      throw new Error("cannot open");
    }
  });
  const first = host.execute({ type: "file.open", path: "/failure" });
  const second = host.execute({ type: "file.open", path: "/success" });
  assert.deepEqual(first.accepted, { ok: true });
  fail();
  assert.deepEqual(await first.completed, { ok: false, message: "cannot open" });
  assert.deepEqual(await second.completed, { ok: true });
  assert.equal(host.state().actionError, "cannot open");
});

test("failures reported through effect events remain correlated on identical retries", async () => {
  const host = driver(workspace(), async (effect, dispatch) => {
    if (effect.type === "file.open") await dispatch({ type: "action.failed", message: "cannot open" });
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const execution = host.execute({ type: "file.open", path: "/file" });
    assert.deepEqual(execution.accepted, { ok: true });
    assert.deepEqual(await execution.completed, { ok: false, message: "cannot open" });
  }
});

test("a refused send to an existing thread reports failure on each request", async () => {
  const host = driver(workspace({ threads: [task("caller")], creatingWorktrees: ["caller"] }));
  for (const requestId of ["first", "second"]) {
    const response = await answerThreadRequest(host, {
      type: "thread.request", requestId, taskId: "caller", op: "command",
      command: { type: "task.send", taskId: "caller", text: "continue" },
    });
    assert.equal(response.requestId, requestId);
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.message, /worktree/i);
  }
});

test("overlapping start requests return the thread created by their own resolution", async () => {
  const pending: (() => Promise<void>)[] = [];
  const host = driver(workspace({ threads: [task("caller")] }), (effect, dispatch) => {
    if (effect.type !== "resolve-run-workspace") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      pending.push(async () => {
        try {
          await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: "scratch", kind: "projectless", root: "/scratch" } });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  const request = (requestId: string, text: string) => answerThreadRequest(host, {
    type: "thread.request", requestId, taskId: "caller", op: "command",
    command: { type: "task.send", text },
  });
  const first = request("first", "first prompt");
  const second = request("second", "second prompt");
  assert.equal(pending.length, 2);
  await Promise.all(pending.map((resolve) => resolve()));
  const responses = await Promise.all([first, second]);
  const ids: string[] = [];
  for (const [index, response] of responses.entries()) {
    assert.equal(response.ok, true);
    if (!response.ok) continue;
    const result = response.result as { thread: { id: string } };
    ids.push(result.thread.id);
    const thread = host.state().threads.find((item) => item.id === result.thread.id);
    assert.equal(thread?.messages[0]?.text, index === 0 ? "first prompt" : "second prompt");
  }
  assert.notEqual(ids[0], ids[1]);
});

test("a failed workspace resolution rejects its send after synchronous acceptance", async () => {
  const host = driver(workspace(), async (effect, dispatch) => {
    if (effect.type === "resolve-run-workspace") await dispatch({ type: "run.unresolved", pendingId: effect.pendingId, message: "checkout failed" });
  });
  const execution = host.execute({ type: "task.send", text: "hello" });
  assert.deepEqual(execution.accepted, { ok: true });
  assert.deepEqual(await execution.completed, { ok: false, message: "checkout failed" });
  assert.equal(host.state().threads.length, 0);
});

test("attachment overflow reports each refusal while preserving the files that fit", async () => {
  const host = driver(workspace({ threads: [task("thread")], currentId: "thread" }));
  const files = Array.from({ length: MAX_ATTACHED_FILES + 1 }, (_, index) => ({ path: `/tmp/${index}`, name: `file-${index}` }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await host.execute({ type: "file.attach", files }).completed;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /up to 10 files/);
    assert.equal(host.state().files.thread.length, MAX_ATTACHED_FILES);
  }
  for (let index = 0; index < MAX_ATTACHMENTS; index++) await host.execute({ type: "image.add", path: `/tmp/${index}.png`, label: "" }).completed;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await host.execute({ type: "image.add", path: "/tmp/overflow.png", label: "" }).completed;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /up to 6 images/);
    assert.equal(host.state().images.thread.length, MAX_ATTACHMENTS);
  }
});

test("dedicated panel errors reject their commands without moving the error to another panel", async () => {
  const host = driver(workspace({ projects: [PROJECT], threads: [task("thread", { projectId: PROJECT.id })], currentId: "thread" }), async (effect, dispatch) => {
    if (effect.type === "register-project") await dispatch({ type: "project.register-failed", projectId: effect.projectId, message: "folder unavailable" });
    if (effect.type === "list-worktrees") await dispatch({ type: "worktrees.failed", message: "worktrees unavailable" });
    if (effect.type === "read-diff") await dispatch({ type: "diff.loaded", owner: effect.owner, workspaceId: effect.workspaceId, range: effect.range, result: { status: "error", message: "diff unavailable" } });
    if (effect.type === "engine.read") await dispatch({ type: "engine.failed", message: "engine unavailable" });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await host.execute({ type: "project.edit", projectId: PROJECT.id, root: "/missing" }).completed, { ok: false, message: "folder unavailable" });
    assert.equal(host.state().projectEdit?.error, "folder unavailable");
    assert.deepEqual(await host.execute({ type: "worktree.refresh" }).completed, { ok: false, message: "worktrees unavailable" });
    assert.equal(host.state().worktreeManagementError, "worktrees unavailable");
    assert.deepEqual(await host.execute({ type: "diff.refresh" }).completed, { ok: false, message: "diff unavailable" });
    assert.equal(host.state().actionError, null);
  }
  assert.equal((await host.execute({ type: "worktree.delete", root: "/missing" }).completed).ok, false);
  assert.equal(host.state().actionError, null);
  assert.deepEqual(await host.execute({ type: "engine.read", refresh: true }).completed, { ok: false, message: "engine unavailable" });
  assert.equal(host.state().actionError, "engine unavailable");
});

test("a started thread keeps its successful result when its carried diff refresh fails", async () => {
  let runs = 0;
  const host = driver(workspace({ projects: [PROJECT], draftProjectId: PROJECT.id, diffs: { [DRAFT_DOCK]: EMPTY_DIFF } }), async (effect, dispatch) => {
    if (effect.type === "resolve-run-workspace") await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: PROJECT.workspaceId!, kind: "project", root: PROJECT.root } });
    if (effect.type === "start-run") runs++;
    if (effect.type === "read-diff") await dispatch({ type: "diff.loaded", owner: effect.owner, workspaceId: effect.workspaceId, range: effect.range, result: { status: "error", message: "diff unavailable" } });
    if (effect.type === "refresh-environment") await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, result: { status: "error", message: "git unavailable" } });
  });
  await host.execute({ type: "view.set-prompt", prompt: "Start the task" }).completed;
  const result = await host.execute({ type: "task.send" }).completed;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.taskId, host.state().threads[0].id);
  assert.equal(runs, 1);
  assert.deepEqual(host.state().diffs[result.taskId!].result, { status: "error", message: "diff unavailable" });
  assert.deepEqual(await host.execute({ type: "diff.refresh" }).completed, { ok: false, message: "diff unavailable" });
  assert.deepEqual(await host.execute({ type: "view.refresh-environment" }).completed, { ok: false, message: "git unavailable" });
});
