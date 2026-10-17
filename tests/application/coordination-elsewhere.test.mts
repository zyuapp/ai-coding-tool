import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { coordinationMembers, coordinationRole, coordinationView } from "../../src/application/coordination.ts";
import { sidebarLists } from "../../src/application/sidebar-lists.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, effectAt, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

/**
 * A coordinator here and the threads it started on paired computers, as each side sees them: here,
 * through the state each computer publishes; there, as threads of that computer's own.
 */

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

const link = (id: string, overrides: Partial<ComputerLink> = {}): ComputerLink => ({ id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, ...overrides });

function paired(id: string, remote: WorkspaceState, overrides: Partial<ComputerLink> = {}): PairedComputer {
  return { ...link(id, overrides), state: remote };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[]): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers } };
}

function lead(id = "lead", overrides = {}) {
  return task(id, { role: "coordinator", ...overrides });
}

/** A coordinator here, and a paired computer "studio" holding a thread the coordinator started there. */
const FAR = { threadId: "lead", title: "Lead", computer: "This Mac" };
const far = (overrides: Partial<Thread> = {}) => task("far", { title: "Far work", remoteLead: FAR, createdAt: 10, ...overrides });
const coordinating = (holder: WorkspaceState, link: Partial<ComputerLink> = {}) => withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })] }), [paired("studio", holder, { capabilities: COMPUTER_CAPABILITIES, ...link })]);
const mirrored = (state: WorkspaceState, holder: WorkspaceState) => reduce(state, { type: "computer.state", id: "studio", state: holder });
const notesOf = (state: WorkspaceState) => (state.threads.find((thread) => thread.id === "lead")?.coordinationNotes ?? []).map((note) => note.text);
const wakesOf = (state: WorkspaceState) => Object.values(state.pendingRuns).filter((pending) => pending.taskId === "lead");

test("a paired computer's member folds under its coordinator", () => {
  const holder = workspace({ threads: [far(), task("other", { title: "Unrelated" })] });
  const state = coordinating(holder);
  const lead = state.threads[0]!;
  const lists = sidebarLists(state, [], [lead, ...holder.threads], new Set(), new Set());
  assert.deepEqual(lists.threadsByCoordinator.get("lead")?.map((thread) => thread.id), ["far"]);
  assert.deepEqual(coordinationMembers(state, "lead").map(({ thread, computer }) => [thread.id, computer?.id]), [["far", "studio"]]);
  const view = coordinationView(state, lead, new Set(), new Set());
  assert.deepEqual(view.members.map(({ thread, host }) => [thread.id, host?.name]), [["far", "studio"]]);
  assert.deepEqual(coordinationMembers({ ...state, threads: [{ ...lead, role: undefined }] }, "lead"), [], "only a live coordinator here has threads there");
});

test("its turn end, report and decision reach the coordinator, once each, even across a dropped link", () => {
  let state = coordinating(workspace());
  state = mirrored(state, workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } })).state;
  assert.deepEqual(notesOf(state), ["\"Far work\" started on studio."]);
  assert.deepEqual(wakesOf(state), [], "showing up is heard quietly");
  assert.equal(state.threads[0]!.remoteHeard?.far, 10);

  state = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("studio", { status: "offline", capabilities: COMPUTER_CAPABILITIES })] }).state;
  state = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] }).state;
  const decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 20 };
  const finished = workspace({ threads: [far({ report: { state: "done", summary: "Tests pass", at: 30 }, decisions: [decision], runEndedAt: 40, outcome: "finished" })] });
  const caught = mirrored(state, finished);
  assert.deepEqual(notesOf(caught.state).slice(1), [
    "\"Far work\" asked the user to decide: Keep the old API?",
    "\"Far work\" reported done: Tests pass",
    "\"Far work\" ended its turn.",
  ], "what happened while the line was down is caught up once it is back");
  assert.equal(caught.state.threads[0]!.remoteHeard?.far, 40);
  assert.ok(caught.effects.some((effect) => effect.type === "announce-thread" && effect.notice.headline === "Needs you: Keep the old API?"));
  assert.equal(wakesOf(caught.state).length, 1, "with nothing working there, the news wakes the coordinator");

  const again = mirrored(caught.state, { ...finished, activeRuns: {} });
  assert.deepEqual(notesOf(again.state), notesOf(caught.state), "each is heard once");
});

test("a member stopped by Stop all is heard quietly", () => {
  const holder = workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } });
  let state = mirrored(coordinating(workspace()), holder).state;
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(effectOf(stopped, "computer.forward"), { type: "computer.forward", id: "studio", inputs: [{ type: "run.cancel", taskId: "far" }] });
  assert.deepEqual(stopped.state.quietStops, ["run-far"]);
  state = mirrored(stopped.state, workspace({ threads: [far({ runEndedAt: 50, outcome: "stopped" })] })).state;
  assert.equal(notesOf(state).at(-1), "\"Far work\" was stopped.");
  assert.equal(state.threads[0]!.coordinationNotes!.at(-1)!.quiet, true);
  assert.deepEqual(wakesOf(state), [], "nothing it stopped wakes the coordinator");
  assert.deepEqual(state.quietStops, []);
});

test("a relayed notice for a remote member of a local coordinator is dropped", () => {
  const state = coordinating(workspace({ threads: [far(), task("other", { title: "Unrelated" })] }));
  assert.deepEqual(reduce(state, { type: "computer.notice", id: "studio", notice: { taskId: "far", title: "Far work", headline: "The run finished." } }).effects, [], "it is announced here, under its coordinator");
  const other = { taskId: "other", title: "Unrelated", headline: "The run finished." };
  assert.deepEqual(reduce(state, { type: "computer.notice", id: "studio", notice: other }).effects, [{ type: "announce-thread", notice: other }]);
});

test("archiving the coordinator releases its remote members, and a computer that was offline is released when it reconnects", () => {
  const released = { type: "task.set-coordinator", taskId: "far", coordinatorId: null };
  const state = withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })] }), [
    paired("studio", workspace({ threads: [far()] }), { capabilities: COMPUTER_CAPABILITIES }),
    paired("linux", workspace({ threads: [far({ id: "away" })] }), { status: "offline", capabilities: COMPUTER_CAPABILITIES }),
  ]);
  const archived = reduce(state, { type: "task.archive", taskId: "lead" });
  const forwards = archived.effects.filter((effect) => effect.type === "computer.forward");
  assert.deepEqual(forwards, [{ type: "computer.forward", id: "studio", inputs: [released], silent: true }], "only a line that is up carries it");
  const back = reduce(archived.state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES }), link("linux", { capabilities: COMPUTER_CAPABILITIES })] });
  assert.deepEqual(back.effects.filter((effect) => effect.type === "computer.forward" && effect.silent), [{ type: "computer.forward", id: "linux", inputs: [{ ...released, taskId: "away" }], silent: true }]);
});

/** A coordinator on a paired computer, as the thread it started here names it. */
const LEAD_THERE = { threadId: "lead-there", title: "Lead", computer: "Laptop" };

test("a thread whose coordinator is on another computer runs as a member there and records its own reports and decisions", () => {
  const state = workspace({ threads: [task("member", { title: "Member", remoteLead: LEAD_THERE })] });
  const sending = reduce(state, { type: "task.send", taskId: "member", text: "Carry on" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.equal(effectAt(started, "start-run").command.coordinationRole, "member");

  const reported = reduce(state, { type: "coordination.reported", taskId: "member", state: "blocked", summary: "No GPU here" });
  assert.deepEqual([reported.state.threads[0]!.report?.state, reported.state.threads[0]!.report?.summary], ["blocked", "No GPU here"]);
  assert.deepEqual(reported.effects, [], "the coordinator's computer hears it, and says it, there");
  const raised = reduce(state, { type: "coordination.decision-raised", taskId: "member", request: { question: "Drop the old API?", options: [] } });
  assert.equal(raised.state.threads[0]!.decisions?.[0]?.question, "Drop the old API?");
  assert.deepEqual(raised.effects, []);

  const view = coordinationView(raised.state, raised.state.threads[0], new Set(), new Set());
  assert.deepEqual(view.remoteLead, { title: "Lead", computer: "Laptop", threadId: null }, "a coordinator no paired computer here holds cannot be gone to");
  assert.deepEqual(view.decisions, [], "its decision is answered on its coordinator's card");
  assert.equal(view.asking, true);

  const other = { ...state, threads: [...state.threads, task("other", { title: "Other" })] };
  const signed = reduce(other, { type: "task.send", taskId: "member", text: "Rebase", from: "other" });
  assert.match(Object.values(signed.state.pendingRuns)[0]!.prompt, /works under the coordinator "Lead" \[lead-there\], which did not send this message/);
});

test("a remote member's decision and approval are answered on its own computer", () => {
  const decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 5 };
  const approval = { approvalId: "a1", taskId: "far", runId: "run-far", title: "Run tests", description: "", toolName: "Bash", input: {} };
  const holder = workspace({
    threads: [task("far", { title: "Far work", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" }, decisions: [decision] })],
    activeRuns: { far: activeRun("far", "run-far", { status: "awaiting-approval" }) },
    approvals: { "run-far": approval },
  });
  const state = workspace({
    threads: [lead("lead", { title: "Lead" })],
    currentId: "lead",
    computers: { ...workspace().computers, name: "Mac", paired: [{ id: "studio", name: "Studio", host: "studio.test", pairedAt: 1, status: "connected", error: null, state: holder }] },
  });
  const view = deriveView(state).coordination;
  assert.deepEqual(view.approvals.map(({ thread, approval: waiting }) => [thread.id, waiting.approvalId]), [["far", "a1"]]);
  assert.deepEqual(view.decisions.map(({ thread, decision: open }) => [thread.id, open.id]), [["far", "d1"]]);
  assert.equal(view.members[0]!.status, "approval");

  for (const input of [
    { type: "decision.answer", taskId: "far", decisionId: "d1", answer: "Keep it" },
    { type: "run.decide", taskId: "far", runId: "run-far", approvalId: "a1", allow: true },
  ] satisfies WorkspaceInput[]) {
    const carried = reduce(state, input);
    assert.deepEqual(effectOf(carried, "computer.forward"), { type: "computer.forward", id: "studio", inputs: [input] }, `${input.type} is decided where the thread is`);
  }
});

test("moving a remote member out clears its remote lead", () => {
  const state = workspace({ threads: [task("member", { remoteLead: LEAD_THERE, resolvedAt: 3 }), lead("here")] });
  const left = reduce(state, { type: "task.set-coordinator", taskId: "member", coordinatorId: null }).state;
  assert.equal(left.threads[0]!.remoteLead, undefined);
  assert.equal(left.threads[0]!.resolvedAt, undefined);
  assert.equal(coordinationRole(left.threads, left.threads[0]!), undefined);
  const moved = reduce(state, { type: "task.set-coordinator", taskId: "member", coordinatorId: "here" }).state;
  assert.deepEqual([moved.threads[0]!.parentId, moved.threads[0]!.remoteLead], ["here", undefined], "a coordinator here takes it from the one elsewhere");
});
