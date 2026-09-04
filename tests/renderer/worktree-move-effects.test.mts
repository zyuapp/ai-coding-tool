import assert from "node:assert/strict";
import { test } from "vitest";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { runProjectEffect } from "../../src/renderer/task-workspace/project-effects.ts";
import { madeWorktree } from "../application/workspace-reducer-fixtures.mts";

test("creating a move destination leaves source changes in place and reports its name and project", async () => {
  const calls: Parameters<DesktopAPI["createWorktree"]>[0][] = [];
  const events: WorkspaceInput[] = [];
  const desktop = { createWorktree: async (input: Parameters<DesktopAPI["createWorktree"]>[0]) => { calls.push(input); return madeWorktree(); } } as DesktopAPI;
  const host = { desktop, dispatch: async (input: WorkspaceInput) => { events.push(input); }, environmentRefreshes: { current: new Map() } };
  await runProjectEffect({ type: "create-worktree", taskId: "thread", projectRoot: "/source/worktree", move: true, name: "Fix login", projectId: "source-project" }, host);
  assert.deepEqual(calls, [{ projectRoot: "/source/worktree", carryChanges: false }]);
  const event = events[0];
  assert.equal(event.type, "worktree.created");
  if (event.type !== "worktree.created") return;
  assert.equal(event.move, true);
  assert.equal(event.projectId, "source-project");
  assert.equal(event.worktree.name, "Fix login");
  await runProjectEffect({ type: "create-worktree", taskId: "thread", projectRoot: "/project" }, host);
  assert.equal(calls[1].carryChanges, true);
});

test("creation failure reports the thread so the reducer can retain its source checkout", async () => {
  const events: WorkspaceInput[] = [];
  const desktop = { createWorktree: async () => { throw new Error("No disk space"); } } as unknown as DesktopAPI;
  await runProjectEffect({ type: "create-worktree", taskId: "thread", projectRoot: "/project", move: true }, {
    desktop, dispatch: async (input) => { events.push(input); }, environmentRefreshes: { current: new Map() },
  });
  assert.deepEqual(events, [{ type: "worktree.failed", taskId: "thread", message: "Could not create the worktree: No disk space" }]);
});
