import assert from "node:assert/strict";
import { test } from "vitest";
import { QUEUED_ATTACHMENTS_ELSEWHERE } from "../../src/application/computers.ts";
import { QUEUED_NOT_YOURS } from "../../src/application/state/runs.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { PairedComputer, WorkspaceState } from "../../src/application/workspace-state.ts";
import { activeRun, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

const remoteState = workspace({
  projects: [{ id: "remote-project", root: "/linux/app", workspaceId: "ws-remote" }],
  threads: [task("remote-thread", { projectId: "remote-project", title: "Remote work" })],
  currentId: "remote-thread",
});

function paired(id: string, remote: WorkspaceState): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, state: remote };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[], extra: Partial<WorkspaceState["computers"]> = {}): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers, ...extra } };
}

test("editing a paired computer's queued message drops it there and drafts it here", () => {
  const message = { id: "queued", text: "Check the logs", prompt: "Check the logs", attachments: [] };
  const remote = { ...remoteState, activeRuns: { "remote-thread": activeRun("remote-thread", "remote-run") }, queuedMessages: { "remote-thread": [message] } };
  const state = withComputers(workspace({ prompts: { "remote-thread": "and then" } }), [paired("linux", remote)], { active: "linux" });
  const edited = reduce(state, { type: "task.edit-queued", messageId: "queued" });

  assert.deepEqual(effectOf(edited, "computer.forward").inputs, [{ type: "task.drop-queued", taskId: "remote-thread", messageId: "queued" }]);
  assert.equal(edited.state.prompts["remote-thread"], "Check the logs\n\nand then");
  assert.deepEqual(edited.state.queuedMessages, {}, "the queue stays the holder's");

  const imaged = withComputers(workspace(), [paired("linux", { ...remote, queuedMessages: { "remote-thread": [{ ...message, attachments: ["/linux/shot.png"] }] } })], { active: "linux" });
  assert.equal(reduce(imaged, { type: "task.edit-queued", messageId: "queued" }).state.actionError, QUEUED_ATTACHMENTS_ELSEWHERE);

  for (const [what, theirs] of [["a decision's answer", { answers: "d1" }], ["another thread's message", { origin: { kind: "thread" as const, threadId: "lead", title: "Lead" }, detail: "From Lead · lead" }]] as const) {
    const held = withComputers(workspace(), [paired("linux", { ...remote, queuedMessages: { "remote-thread": [{ ...message, ...theirs }] } })], { active: "linux" });
    const refused = reduce(held, { type: "task.edit-queued", messageId: "queued" });
    assert.equal(refused.state.actionError, QUEUED_NOT_YOURS, what);
    assert.equal(refused.effects.some((effect) => effect.type === "computer.forward"), false, `${what} stays queued there`);
    assert.equal(refused.state.prompts["remote-thread"], undefined, `${what} is not drafted here`);
  }
});

