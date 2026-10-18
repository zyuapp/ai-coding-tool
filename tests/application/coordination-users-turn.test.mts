import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, correlatedRunEvent, effectAt, required, task, workspace } from "./workspace-reducer-fixtures.mts";

/**
 * A turn the user's own message started in a coordinator's thread: the user is there to see it end,
 * so its coordinator hears of it with its next wake rather than spending one on it.
 */

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

const lead = (overrides: Partial<Thread> = {}) => task("lead", { role: "coordinator", title: "Lead", ...overrides });
const member = (id: string, overrides: Partial<Thread> = {}) => task(id, { parentId: "lead", title: id, ...overrides });
const wakesOf = (state: WorkspaceState) => Object.values(state.pendingRuns).filter((pending) => pending.taskId === "lead");
const lastNote = (state: WorkspaceState) => required(state.threads.find((thread) => thread.id === "lead")?.coordinationNotes?.at(-1));

/** Sends `input` to "one", resolves the run it starts, and returns the run's id. */
function started(state: WorkspaceState, input: WorkspaceInput): { state: WorkspaceState; runId: string } {
  const sent = reduce(state, input);
  const resolved = reduce(sent.state, { type: "run.resolved", pendingId: effectAt(sent, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  return { state: resolved.state, runId: required(resolved.state.activeRuns.one).runId };
}

function ended(state: WorkspaceState, runId: string, status: "succeeded" | "failed" | "cancelled" = "succeeded", sequence = 1): WorkspaceTransition {
  return reduce(state, correlatedRunEvent("one", runId, sequence, { type: "run.status", status }));
}

const idle = () => workspace({ threads: [lead(), member("one"), member("two")] });
const usersMessage: WorkspaceInput = { type: "task.send", taskId: "one", text: "Rename the flag too" };

test("a turn the user's own message started ends quietly, and its news goes with the coordinator's next wake", () => {
  const turn = started(idle(), usersMessage);
  assert.equal(turn.state.activeRuns.one?.usersOwn, true);
  const done = ended(turn.state, turn.runId);
  assert.match(lastNote(done.state).text, /"one" ended its turn/);
  assert.equal(lastNote(done.state).quiet, true);
  assert.deepEqual(wakesOf(done.state), [], "the coordinator is not woken to hear what the user watched happen");

  const stopped = ended(turn.state, turn.runId, "cancelled");
  assert.equal(lastNote(stopped.state).quiet, true, "nor when the user stops their own turn");
  assert.deepEqual(wakesOf(stopped.state), []);

});

test("the held news is heard when something else wakes the coordinator", () => {
  const turn = started(idle(), usersMessage);
  const done = ended(turn.state, turn.runId).state;
  const failing = { ...done, activeRuns: { ...done.activeRuns, two: activeRun("two", "run-2") }, runStatuses: { ...done.runStatuses, two: "running" as const } };
  const failed = reduce(failing, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "failed" }));
  const wake = required(wakesOf(failed.state)[0]);
  assert.match(wake.text, /"one" ended its turn[\s\S]*"two" failed/);
});

test("a turn of the user's own that fails, reports it cannot go on, or puts a decision to the user still wakes the coordinator", () => {
  const failed = (() => {
    const turn = started(idle(), usersMessage);
    return ended(turn.state, turn.runId, "failed");
  })();
  assert.equal(lastNote(failed.state).quiet, undefined);
  assert.equal(wakesOf(failed.state).length, 1, "a failure is news");

  const blocked = (() => {
    const turn = started(idle(), usersMessage);
    const reported = reduce(turn.state, { type: "coordination.reported", taskId: "one", state: "blocked", summary: "Needs a token" }).state;
    return ended(reported, turn.runId);
  })();
  assert.equal(wakesOf(blocked.state).length, 1, "being blocked is news");
  assert.match(required(wakesOf(blocked.state)[0]).text, /reported blocked: Needs a token/);

  const asked = (() => {
    const turn = started(idle(), usersMessage);
    const raised = reduce(turn.state, { type: "coordination.decision-raised", taskId: "one", request: { question: "Keep the old flag?", options: [] } }).state;
    return ended(raised, turn.runId);
  })();
  assert.equal(wakesOf(asked.state).length, 1, "a decision is news");
  assert.match(required(wakesOf(asked.state)[0]).text, /asked the user to decide: Keep the old flag\?/);
});

test("a turn the coordinator, another thread, or a decision's answer started is news, and so is one they joined", () => {
  const messaged = started(idle(), { type: "task.send", taskId: "one", text: "Also bump the version", from: "lead" });
  assert.equal(messaged.state.activeRuns.one?.usersOwn, undefined);
  assert.equal(wakesOf(ended(messaged.state, messaged.runId).state).length, 1, "the coordinator's own message");

  const decision = { id: "d1", question: "Ship?", options: [], raisedAt: 1 };
  const answered = started(workspace({ threads: [lead(), member("one", { decisions: [decision] })] }), { type: "decision.answer", taskId: "one", decisionId: "d1", answer: "Yes" });
  assert.equal(answered.state.activeRuns.one?.usersOwn, undefined);
  assert.equal(wakesOf(ended(answered.state, answered.runId).state).length, 1, "the answer to a decision");

  const turn = started(idle(), usersMessage);
  const steered = reduce(turn.state, { type: "task.send", taskId: "one", text: "And update the docs", from: "lead", steer: true }).state;
  const messageId = required(steered.queuedMessages.one?.[0]).id;
  const joined = reduce(steered, correlatedRunEvent("one", turn.runId, 1, { type: "queued.delivered", messageId })).state;
  assert.equal(joined.activeRuns.one?.usersOwn, undefined, "the coordinator's message joined the turn");
  assert.equal(wakesOf(ended(joined, turn.runId, "succeeded", 2).state).length, 1);

  const own = reduce(turn.state, { type: "task.send", taskId: "one", text: "And the changelog", steer: true }).state;
  const ownId = required(own.queuedMessages.one?.[0]).id;
  const stillOwn = reduce(own, correlatedRunEvent("one", turn.runId, 1, { type: "queued.delivered", messageId: ownId })).state;
  assert.equal(stillOwn.activeRuns.one?.usersOwn, true, "the user's own steer keeps the turn theirs");
});

test("a queued answer to a decision is still the decision's when it starts its run", () => {
  const decision = { id: "d1", question: "Ship?", options: [], raisedAt: 1, answer: "Yes", answeredAt: 2 };
  const answer = { id: "q1", text: "The user decided \"Ship?\": Yes", prompt: "The user decided \"Ship?\": Yes", attachments: [], answers: "d1" };
  const busy = workspace({ threads: [lead(), member("one", { decisions: [decision] })], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" }, queuedMessages: { one: [answer] } });
  const finished = reduce(busy, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  const pending = required(Object.values(finished.state.pendingRuns).find((item) => item.taskId === "one"));
  assert.equal(pending.answers, "d1");
  const resolved = reduce(finished.state, { type: "run.resolved", pendingId: pending.id, workspace: PROJECTLESS }).state;
  assert.equal(resolved.activeRuns.one?.usersOwn, undefined);
});

test("a next step pressed on the coordinator's card is the coordinator's news when its turn ends", () => {
  const pullRequest = { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix it", state: "open" as const, checks: "failing" as const };
  const failing = member("one", { brief: { intent: "fix the login test", doneWhen: "the suite passes", delivers: "pull-request" }, pullRequest });
  const turn = started(workspace({ threads: [lead(), failing], currentId: "lead" }), { type: "coordination.next-step", taskId: "one", step: "fix-ci" });
  assert.equal(turn.state.activeRuns.one?.usersOwn, undefined, "the coordinator offered the step");
  assert.equal(wakesOf(ended(turn.state, turn.runId).state).length, 1, "so it is woken to hear how it went");
});

test("a thread's message to itself, and one from a build that kept only a label, are never taken for the user's", () => {
  const own = started(idle(), { type: "task.send", taskId: "one", text: "Carry on with the migration", from: "one" });
  assert.equal(own.state.activeRuns.one?.usersOwn, undefined, "a thread writing to itself is not the user");
  assert.equal(wakesOf(ended(own.state, own.runId).state).length, 1);

  const labelled = { id: "q1", text: "Also bump the version", prompt: "Also bump the version", attachments: [], detail: "From Lead" };
  const busy = workspace({ threads: [lead(), member("one")], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" }, queuedMessages: { one: [labelled] } });
  const drained = reduce(busy, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  const pending = required(Object.values(drained.state.pendingRuns).find((item) => item.taskId === "one"));
  assert.deepEqual(pending.messageOrigin, { kind: "thread", title: "Lead" }, "the label still says who sent it");
  const resolved = reduce(drained.state, { type: "run.resolved", pendingId: pending.id, workspace: PROJECTLESS }).state;
  assert.equal(resolved.activeRuns.one?.usersOwn, undefined);
  assert.equal(required(resolved.threads.find((thread) => thread.id === "one")?.messages.at(-1)).origin?.kind, "thread");

  const typed = reduce(busy, { type: "task.send", taskId: "one", text: "And the changelog" }).state;
  assert.equal(typed.queuedMessages.one?.at(-1)?.usersOwn, true, "what the user queues stays theirs when it goes");
});

/** A coordinator here and "far", a thread it started on the paired computer "studio". */
const FAR = { threadId: "lead", title: "Lead", computer: "This Mac" };
const far = (overrides: Partial<Thread> = {}) => task("far", { title: "Far work", remoteLead: FAR, createdAt: 10, ...overrides });
const studio = (state: WorkspaceState | null): PairedComputer => ({ id: "studio", name: "studio", host: "studio.tail.ts.net", status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state });
const coordinating = (holder: WorkspaceState): WorkspaceState => {
  const here = workspace({ threads: [lead()] });
  return { ...here, computers: { ...here.computers, name: "This Mac", paired: [studio(holder)] } };
};
const mirrored = (state: WorkspaceState, holder: WorkspaceState) => reduce(state, { type: "computer.state", id: "studio", state: holder });

test("a paired computer's member ends a turn of the user's own quietly, as one here does, unless it failed", () => {
  const running = (overrides = {}) => mirrored(coordinating(workspace()), workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far", overrides) } })).state;

  const own = mirrored(running({ usersOwn: true }), workspace({ threads: [far({ runEndedAt: 40, outcome: "finished" })] })).state;
  assert.equal(lastNote(own).text, "\"Far work\" ended its turn.");
  assert.equal(lastNote(own).quiet, true);
  assert.deepEqual(wakesOf(own), [], "the user there watched it end");

  const failed = mirrored(running({ usersOwn: true }), workspace({ threads: [far({ runEndedAt: 40, outcome: "failed" })] })).state;
  assert.equal(lastNote(failed).quiet, undefined);
  assert.equal(wakesOf(failed).length, 1, "a failure is news from there too");

  const asked = mirrored(running({ usersOwn: true }), workspace({ threads: [far({ runEndedAt: 40, outcome: "finished", decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 30 }] })] })).state;
  assert.equal(wakesOf(asked).length, 1, "and so is a decision it put to the user");

  const sent = mirrored(running(), workspace({ threads: [far({ runEndedAt: 40, outcome: "finished" })] })).state;
  assert.equal(lastNote(sent).quiet, undefined, "a turn someone else started there, or one from a build that cannot tell, is news");
  assert.equal(wakesOf(sent).length, 1);
});
