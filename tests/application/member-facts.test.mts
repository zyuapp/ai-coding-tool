import assert from "node:assert/strict";
import { test } from "vitest";
import { heardFacts, withFactsHeard, type MemberFact } from "../../src/application/member-facts.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { reduce, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { CoordinationNote, Decision } from "../../src/domain/coordination.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, correlatedRunEvent, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const at = 1_800_000_000_000;
const DECISION: Decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 20 };
const lead = () => task("lead", { role: "coordinator", title: "Lead" });
const worker = (overrides: Partial<Thread> = {}) => task("worker", { parentId: "lead", title: "Worker", ...overrides });
const noteShape = ({ threadId, text, urgent, quiet, runId }: CoordinationNote) => ({ threadId, text, urgent, quiet, runId });
const notesOf = (state: WorkspaceState) => (required(state.threads.find((thread) => thread.id === "lead")).coordinationNotes ?? []).map(noteShape);
const noticesOf = (transitions: WorkspaceTransition[]) => transitions.flatMap(({ effects }) => effects.flatMap((effect) => effect.type === "announce-thread" ? [[effect.notice.title, effect.notice.headline]] : []));

test("progress is no news, a report that the thread is done is only a note, and one that cannot go on is the user's at once", () => {
  const state = workspace({ threads: [lead(), worker()] });
  const [coordinator, member] = state.threads as [Thread, Thread];
  const heard = (fact: MemberFact) => heardFacts(state, coordinator, member, [fact], at);
  assert.deepEqual(heard({ kind: "reported", report: { state: "working", summary: "Halfway", at } }), { notes: [], effects: [] });
  const done = heard({ kind: "reported", report: { state: "done", summary: "Shipped", at }, runId: "run-1" });
  assert.deepEqual(done.notes.map(noteShape), [{ threadId: "worker", text: "\"Worker\" reported done: Shipped", urgent: undefined, quiet: undefined, runId: "run-1" }]);
  assert.deepEqual(done.effects, []);
  const blocked = heard({ kind: "reported", report: { state: "blocked", summary: "No access", at } });
  assert.equal(blocked.notes[0]!.urgent, true);
  assert.deepEqual(noticesOf([{ state, effects: blocked.effects }]), [["Lead · Worker", "Blocked: No access"]]);
});

test("a decision is noted for the coordinator and put to the user under it", () => {
  const state = workspace({ threads: [lead(), worker()] });
  const heard = withFactsHeard(state, state.threads[0]!, state.threads[1]!, [{ kind: "raised", decision: DECISION, runId: "run-1" }], at);
  assert.deepEqual(notesOf(heard.state).map((note) => [note.text, note.runId]), [["\"Worker\" asked the user to decide: Keep the old API?", "run-1"]]);
  assert.deepEqual(noticesOf([heard]), [["Lead", "Needs you: Keep the old API?"]]);
});

test("a turn's end is told to the user only when its own computer keeps it to itself, as a run here would tell it", () => {
  const state = workspace({ threads: [lead(), worker()] });
  const [coordinator, member] = state.threads as [Thread, Thread];
  const ended = (fact: Extract<MemberFact, { kind: "ended" }>) => heardFacts(state, coordinator, member, [fact], at);
  assert.deepEqual(ended({ kind: "ended", status: "succeeded", quiet: false }).effects, [], "a thread here tells it itself");
  assert.deepEqual(noticesOf([{ state, effects: ended({ kind: "ended", status: "failed", quiet: false, tell: { surfacing: "failed", failure: "Out of disk" } }).effects }]), [["Lead · Worker", "Out of disk"]]);
  assert.deepEqual(ended({ kind: "ended", status: "succeeded", quiet: true, tell: { surfacing: null } }).effects, []);
  const stopped = ended({ kind: "ended", status: "cancelled", quiet: true });
  assert.deepEqual(stopped.notes.map(noteShape), [{ threadId: "worker", text: "\"Worker\" was stopped.", urgent: undefined, quiet: true, runId: undefined }]);
  const arrived = heardFacts(state, coordinator, member, [{ kind: "arrived", computer: "studio" }], at);
  assert.deepEqual(arrived.notes.map((note) => [note.text, note.quiet]), [["\"Worker\" started on studio.", true]]);
});

/**
 * One turn of a thread under the lead: it raises a decision and reports itself blocked while
 * running, then ends having said `REPLY`. Heard once from its own events here, and once from what a
 * paired computer holding it says.
 */
const REPLY = { id: "reply", kind: "assistant" as const, text: "I need the staging key.", at: 25 };
const REPORT = { state: "blocked" as const, summary: "No staging access", at: 20 };

function heardHere(): { state: WorkspaceState; transitions: WorkspaceTransition[] } {
  let state = workspace({ notifications: true, threads: [lead(), worker()], activeRuns: { worker: activeRun("worker", "run-1") }, runStatuses: { worker: "running" } });
  const transitions: WorkspaceTransition[] = [];
  for (const input of [
    { type: "coordination.decision-raised" as const, taskId: "worker", decisionId: DECISION.id, request: { question: DECISION.question, options: [] } },
    { type: "coordination.reported" as const, taskId: "worker", state: REPORT.state, summary: REPORT.summary },
    correlatedRunEvent("worker", "run-1", 1, { type: "assistant.delta", messageId: REPLY.id, text: REPLY.text }),
    correlatedRunEvent("worker", "run-1", 2, { type: "run.status", status: "succeeded" }),
  ]) {
    const next = reduce(state, input);
    transitions.push(next);
    state = next.state;
  }
  return { state, transitions };
}

function heardFromPairedComputer(): { state: WorkspaceState; transitions: WorkspaceTransition[] } {
  const far = (overrides: Partial<Thread> = {}) => task("worker", { title: "Worker", createdAt: 10, remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac" }, ...overrides });
  const running = { worker: activeRun("worker", "run-1") };
  const studio: PairedComputer = { id: "studio", name: "studio", host: "studio.tail.ts.net", status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: null };
  let state: WorkspaceState = { ...workspace({ notifications: true, threads: [lead()] }), computers: { ...workspace().computers, name: "This Mac", paired: [studio] } };
  const transitions: WorkspaceTransition[] = [];
  for (const holder of [
    workspace({ threads: [far()], activeRuns: running }),
    workspace({ threads: [far({ decisions: [DECISION], report: REPORT })], activeRuns: running }),
    workspace({ threads: [far({ decisions: [DECISION], report: REPORT, messages: [REPLY], runEndedAt: 30, runEndedAs: "finished" })] }),
  ]) {
    const next = reduce(state, { type: "computer.state", id: "studio", state: holder });
    transitions.push(next);
    state = next.state;
  }
  return { state, transitions };
}

test("a coordinator hears the same of a thread here and of one on a paired computer", () => {
  const here = heardHere();
  const there = heardFromPairedComputer();
  const [arrived, ...rest] = notesOf(there.state);
  assert.deepEqual(arrived, { threadId: "worker", text: "\"Worker\" started on studio.", urgent: undefined, quiet: true, runId: undefined });
  assert.deepEqual(rest, notesOf(here.state));
  assert.deepEqual(notesOf(here.state).map((note) => note.text), [
    "\"Worker\" asked the user to decide: Keep the old API?",
    "\"Worker\" reported blocked: No staging access",
    "\"Worker\" ended its turn. It last said: I need the staging key.",
  ]);
  assert.deepEqual(noticesOf(there.transitions), noticesOf(here.transitions));
  assert.deepEqual(noticesOf(here.transitions), [
    ["Lead", "Needs you: Keep the old API?"],
    ["Lead · Worker", "Blocked: No staging access"],
    ["Lead · Worker", "The run finished."],
  ]);
});
