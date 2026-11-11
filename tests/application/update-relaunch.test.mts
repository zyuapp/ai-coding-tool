import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { resumableAfterUpdate } from "../../src/application/update-relaunch.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { PendingQuestion } from "../../src/domain/agent-question.ts";
import { parseThreadStore, serializeThreadStore } from "../../src/domain/thread-storage.ts";
import { activeRun, effectOf, PROJECT, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const resolution = { id: PROJECT.workspaceId!, kind: "project" as const, root: PROJECT.root };

function quitMidRun(): WorkspaceState {
  const ids = ["working", "approving", "asking", "other"];
  return workspace({
    projects: [PROJECT],
    threads: ids.map((id) => task(id, { projectId: PROJECT.id, runOpen: true, continuation: { provider: "claude", value: `session-${id}` }, continuationStatus: "available" })),
    activeRuns: {
      working: activeRun("working", "run-working"),
      approving: activeRun("approving", "run-approving", { status: "awaiting-approval" }),
      asking: activeRun("asking", "run-asking", { questions: [{} as PendingQuestion] }),
      other: activeRun("other", "run-other"),
    },
  });
}

function relaunched(before: WorkspaceState, resuming: string[]): WorkspaceTransition {
  const parsed = parseThreadStore(serializeThreadStore({ version: 2, projects: [PROJECT], worktrees: [], lastFolder: null, tasks: before.threads }));
  assert.ok(parsed.ok);
  const loaded = reduce(workspace(), { type: "store.loaded", data: parsed.data, resuming });
  return loaded.effects.reduce<WorkspaceTransition>((current, effect) => effect.type === "resolve-run-workspace"
    ? reduce(current.state, { type: "run.resolved", pendingId: effect.pendingId, workspace: resolution })
    : current, loaded);
}

test("an update carries on the turns it cut off, on the session each was in", () => {
  const before = quitMidRun();
  const resuming = resumableAfterUpdate(before);
  assert.deepEqual(resuming.sort(), ["other", "working"], "a turn waiting on the user stays stopped");

  const after = relaunched(before, ["working"]);
  const working = required(after.state.threads.find((thread) => thread.id === "working"));
  assert.equal(working.messages.at(-1)?.text, "App updated. Resuming.");
  assert.equal(working.runEndedAs, undefined);
  assert.equal(after.state.activeRuns.working?.warming, undefined, "nothing waits on it to warm up");
  const start = effectOf(after, "start-run");
  assert.match(start.command.prompt, /restarted to install an update/);
  assert.equal(start.command.continuation?.value, "session-working");

  const other = required(after.state.threads.find((thread) => thread.id === "other"));
  assert.equal(other.runEndedAs, "stopped", "a thread the update did not name ends as it always has");
  assert.equal(after.state.activeRuns.other, undefined);
});

test("a thread whose turn ended before the quit is not started again", () => {
  const before = quitMidRun();
  const ended = { ...before, threads: before.threads.map((thread) => thread.id === "working" ? { ...thread, runOpen: undefined } : thread) };
  const after = relaunched(ended, ["working"]);
  assert.equal(after.effects.some((effect) => effect.type === "start-run"), false);
});
