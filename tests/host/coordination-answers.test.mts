import assert from "node:assert/strict";
import { test } from "vitest";
import { executeWorkspaceInput, type WorkspaceExecution, type WorkspaceExecutionHost } from "../../src/application/workspace-execution.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { answerThreadRequest, type ThreadRequestHost } from "../../src/host/thread-requests.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { MAX_OPEN_DECISIONS } from "../../src/domain/coordination.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

const NO_COORDINATOR = "This thread works under no coordinator, so there is no one to report to and nothing was recorded. Say it in your reply instead.";
const OUTSIDE_COORDINATION = "Only a coordinator and the threads working under it can raise decisions, so nothing was recorded. Ask the user in your reply instead.";
const DECISIONS_FULL = `This thread already has ${MAX_OPEN_DECISIONS} decisions waiting on the user, so this one was not raised. Wait for their answers, or ask in your reply instead.`;
const RAISED = "Raised. The user sees it now, and their answer arrives in this thread as a message. If you cannot go on without it, end your turn.";
const READ_FROM_NOW = "You and every thread you start from now on read it.";

/** The window as the tools reach it. Inputs wait behind `hold` while it is shut. */
function window(initial: WorkspaceState) {
  let state = initial;
  let open: Promise<void> = Promise.resolve();
  let release = () => {};
  const execution: WorkspaceExecutionHost = { state: () => state, commit: (next) => { state = next; }, perform: async () => {} };
  const later = (input: WorkspaceInput): WorkspaceExecution => {
    const run = open.then(() => executeWorkspaceInput(input, execution));
    return { accepted: run.then((made) => made.accepted), completed: run.then((made) => made.completed) };
  };
  const host: ThreadRequestHost = {
    state: () => state,
    desktop: {} as ThreadRequestHost["desktop"],
    dispatch: async (input) => { await later(input).completed; },
    execute: later,
    waiters: { current: [] },
  };
  return {
    host,
    set: (next: WorkspaceState) => { state = next; },
    hold: () => { open = new Promise<void>((resolve) => { release = resolve; }); },
    release: () => release(),
  };
}

type Asked<Op extends ThreadRequest["op"]> = Omit<Extract<ThreadRequest, { op: Op }>, "type" | "requestId" | "taskId">;

function ask(host: ThreadRequestHost, taskId: string, request: Asked<"report"> | Asked<"decision"> | Asked<"memory">): Promise<ThreadResponse> {
  return answerThreadRequest(host, { type: "thread.request", requestId: "r1", taskId, ...request } as ThreadRequest);
}

function result(response: ThreadResponse) {
  if (!response.ok) assert.fail(response.message);
  return response.result;
}

function refusal(response: ThreadResponse) {
  assert.equal(response.ok, false);
  return response.ok ? "" : response.message;
}

const team = () => workspace({ threads: [task("lead", { role: "coordinator" }), task("worker", { parentId: "lead" }), task("alone"), task("far", { remoteLead: { threadId: "lead-there", title: "Lead", computer: "Laptop" } })] });

test("a report is answered with what the window recorded, in the words the tool has always used", async () => {
  const { host } = window(team());
  assert.deepEqual(result(await ask(host, "alone", { op: "report", state: "done", summary: "Done" })), { recorded: false, note: NO_COORDINATOR });
  assert.deepEqual(result(await ask(host, "worker", { op: "report", state: "working", summary: "Halfway" })), { recorded: true, note: "Noted. Progress is not passed on; report again when you are blocked, done, or failed." });
  assert.deepEqual(result(await ask(host, "worker", { op: "report", state: "blocked", summary: "Needs a token" })), { recorded: true, note: "Reported. Your coordinator hears it when this turn ends." });
  assert.deepEqual(result(await ask(host, "far", { op: "report", state: "done", summary: "Shipped" })), { recorded: true, note: "Reported. Your coordinator hears it when this turn ends." });
  assert.equal(host.state().threads[2].report, undefined);
  assert.equal(host.state().threads[3].report?.summary, "Shipped");
  assert.equal(host.state().actionError, null, "a refusal answers the tool, never the user");
});

test("a report that finds its thread out of coordination once the window takes it records nothing", async () => {
  const desk = window(team());
  desk.hold();
  const asked = ask(desk.host, "worker", { op: "report", state: "done", summary: "PR #42" });
  desk.set({ ...desk.host.state(), threads: desk.host.state().threads.map((thread) => thread.id === "worker" ? task("worker") : thread) });
  desk.release();
  assert.deepEqual(result(await asked), { recorded: false, note: NO_COORDINATOR });
  assert.equal(desk.host.state().threads[1].report, undefined);
});

test("a decision is answered with what the window raised, or why it raised nothing", async () => {
  const waiting = Array.from({ length: MAX_OPEN_DECISIONS }, (_, index) => ({ id: `d${index}`, question: `Q${index}?`, options: [], raisedAt: index }));
  const { host } = window(workspace({ threads: [...team().threads, task("full", { parentId: "lead", decisions: waiting })] }));
  const question: Asked<"decision"> = { op: "decision", request: { question: "Ship it?", options: [] } };
  assert.deepEqual(result(await ask(host, "alone", question)), { recorded: false, note: OUTSIDE_COORDINATION });
  assert.deepEqual(result(await ask(host, "ghost", question)), { recorded: false, note: OUTSIDE_COORDINATION });
  assert.deepEqual(result(await ask(host, "full", question)), { recorded: false, note: DECISIONS_FULL });
  assert.deepEqual(result(await ask(host, "worker", question)), { recorded: true, note: RAISED });
  assert.deepEqual(result(await ask(host, "lead", question)), { recorded: true, note: RAISED });
  assert.deepEqual(result(await ask(host, "far", question)), { recorded: true, note: RAISED });
  assert.equal(host.state().threads.find((thread) => thread.id === "full")?.decisions?.length, MAX_OPEN_DECISIONS);
  assert.equal(host.state().actionError, null);
});

test("a decision that finds its thread out of coordination once the window takes it is told so", async () => {
  const desk = window(team());
  desk.hold();
  const asked = ask(desk.host, "worker", { op: "decision", request: { question: "Ship it?", options: [] } });
  desk.set({ ...desk.host.state(), threads: desk.host.state().threads.map((thread) => thread.id === "worker" ? task("worker") : thread) });
  desk.release();
  assert.deepEqual(result(await asked), { recorded: false, note: OUTSIDE_COORDINATION });
  assert.equal(desk.host.state().threads[1].decisions, undefined);
});

test("a coordinator's memory change is answered with what the window saved, and a refusal never reaches the user", async () => {
  const notes = [{ id: "n1", text: "Use Sonnet for docs", at: 1 }];
  const { host } = window(workspace({ threads: [task("lead", { role: "coordinator", memory: { notes, revision: 2, heard: 2 } }), task("solo")] }));
  const memory = (taskId: string, change: Extract<ThreadRequest, { op: "memory" }>["change"]) => ask(host, taskId, { op: "memory", change });
  assert.equal(refusal(await memory("solo", { kind: "remember", text: "Remember this" })), "Only a coordinator keeps a memory.");
  assert.equal(refusal(await memory("ghost", { kind: "remember", text: "Remember this" })), "Only a coordinator keeps a memory.");
  assert.deepEqual(result(await memory("lead", { kind: "remember", text: "  Keep updates short  " })), { note: `Saved as [n3]. ${READ_FROM_NOW}` });
  assert.equal(refusal(await memory("lead", { kind: "remember", text: "   " })), "A note needs some text.");
  assert.deepEqual(result(await memory("lead", { kind: "purpose", purpose: "Ship the v2 reader" })), { note: `Purpose set. ${READ_FROM_NOW}` });
  assert.deepEqual(result(await memory("lead", { kind: "purpose", purpose: "Ship the v2 reader" })), { note: `Purpose set. ${READ_FROM_NOW}` });
  assert.deepEqual(result(await memory("lead", { kind: "purpose", purpose: "" })), { note: "Purpose cleared." });
  assert.deepEqual(result(await memory("lead", { kind: "forget", noteId: "n1" })), { note: "Forgot [n1]." });
  assert.equal(refusal(await memory("lead", { kind: "forget", noteId: "n1" })), "No note has the ID n1.");
  const lead: Thread = host.state().threads[0];
  assert.deepEqual(lead.memory?.notes.map((note) => [note.id, note.text]), [["n3", "Keep updates short"]]);
  assert.equal(host.state().actionError, null);
});

test("a full memory refuses one more note in the tool's answer", async () => {
  const notes = Array.from({ length: 30 }, (_, index) => ({ id: `n${index + 1}`, text: `Note ${index}`, at: 1 }));
  const { host } = window(workspace({ threads: [task("lead", { role: "coordinator", memory: { notes, revision: 30, heard: 30 } })] }));
  assert.equal(refusal(await ask(host, "lead", { op: "memory", change: { kind: "remember", text: "One more" } })), "Memory holds at most 30 notes. Forget one first.");
  assert.equal(host.state().threads[0].memory?.notes.length, 30);
  assert.equal(host.state().actionError, null);
});
