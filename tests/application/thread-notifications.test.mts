import { task } from "./workspace-reducer-fixtures.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ActiveRun } from "../../src/application/thread-run-state.ts";
import type { RunEvent } from "../../src/contracts/ipc.ts";
import { createConversationMessage, createSentMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

function activeRun(taskId: string, overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    taskId,
    runId: "run-1",
    sequence: 0,
    status: "running",
    origin: "composer",
    quiet: false,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 0,
    before: { updatedAt: 1 },
    ...overrides,
  };
}

/** One thread with a run in it, and the user somewhere else. */
function workspace(overrides: Partial<WorkspaceState> = {}, run: Partial<ActiveRun> = {}): WorkspaceState {
  return {
    ...emptyWorkspaceState(),
    threads: [task("task-a")],
    activeRuns: { "task-a": activeRun("task-a", run) },
    currentId: null,
    focused: false,
    restored: true,
    ...overrides,
  };
}

type RunEventPayload = Omit<Extract<RunEvent, { type: "run.status" }>, "taskId" | "runId" | "sequence"> | Omit<Extract<RunEvent, { type: "approval.requested" }>, "taskId" | "runId" | "sequence">;

function fire(state: WorkspaceState, payload: RunEventPayload, taskId = "task-a"): WorkspaceTransition {
  return reduce(state, { type: "run.event", event: { taskId, runId: "run-1", sequence: 1, ...payload } as RunEvent });
}

function headlines(effects: WorkspaceEffect[]): string[] {
  return effects.flatMap((effect) => effect.type === "announce-thread" ? [effect.notice.headline] : []);
}

function titles(effects: WorkspaceEffect[]): string[] {
  return effects.flatMap((effect) => effect.type === "announce-thread" ? [effect.notice.title] : []);
}

const FROM_LEAD = { kind: "thread" as const, threadId: "lead", title: "Release" };

/** A coordinator and one thread under it, each with a run going, and the user somewhere else. */
function coordinated(lead: Partial<Thread> = {}, member: Partial<Thread> = {}, overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return workspace({
    threads: [
      task("lead", { role: "coordinator", title: "Release", ...lead }),
      task("task-a", { parentId: "lead", title: "Fix login", messages: [createSentMessage({ text: "Fix the login test", origin: FROM_LEAD })], ...member }),
    ],
    activeRuns: { lead: activeRun("lead"), "task-a": activeRun("task-a") },
    ...overrides,
  });
}

const APPROVAL = {
  type: "approval.requested" as const,
  approvalId: "approval-1",
  intent: { toolId: "tool-1", name: "Bash", input: { command: "ls" } },
  title: "Bash needs approval",
  description: "Review this action before it runs.",
};

test("a run the user started says how it ended, and a failure carries its own reason", () => {
  assert.equal(workspace().threads[0].parentId, undefined, "a thread under no coordinator");
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "succeeded" }).effects), ["The run finished."]);
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "failed", message: "The tool crashed" }).effects), ["The tool crashed"]);
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "failed" }).effects), ["The run failed."]);
});

test("a run the user ended themselves announces nothing", () => {
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "cancelled" }).effects), []);
});

test("a run that stops to ask names what it is waiting on", () => {
  assert.deepEqual(headlines(fire(workspace(), APPROVAL).effects), ["Waiting for your permission to use Bash"]);
});

test("a scheduled run answers its own questions, so its stop is not the user's to hear about", () => {
  const scheduled = workspace({}, { origin: "automation" });
  assert.deepEqual(headlines(fire(scheduled, APPROVAL).effects), []);
});

test("a scheduled run speaks through what it finds, so finishing says nothing and failing still does", () => {
  const quiet = workspace({}, { origin: "automation", quiet: true, acknowledged: true });
  assert.deepEqual(headlines(fire(quiet, { type: "run.status", status: "succeeded" }).effects), []);

  const loud = workspace({}, { origin: "automation" });
  assert.deepEqual(headlines(fire(loud, { type: "run.status", status: "succeeded" }).effects), [], "a tick reports itself rather than its ending");
  assert.deepEqual(headlines(fire(loud, { type: "run.status", status: "failed", message: "The checkout is gone" }).effects), ["The checkout is gone"]);
});

test("turning notifications off keeps every notice back, and the thread is still marked", () => {
  const silent = workspace({ notifications: false });
  const settled = fire(silent, { type: "run.status", status: "succeeded" });

  assert.deepEqual(headlines(settled.effects), []);
  assert.equal(settled.state.threads[0].outcome, "finished");
  assert.equal(settled.state.threads[0].outcomeUnread, true, "the sidebar still says so");
  assert.deepEqual(headlines(fire(silent, APPROVAL).effects), []);
});

test("the switch is remembered, and an unchanged one writes nothing", () => {
  const off = reduce(workspace(), { type: "view.set-notifications", enabled: false });
  assert.equal(off.state.notifications, false);
  assert.equal(off.effects.filter((effect) => effect.type === "persist-preferences").length, 1);
  assert.deepEqual(reduce(off.state, { type: "view.set-notifications", enabled: false }).effects, []);
});

test("a coordinator's reply is announced with what it said", () => {
  const replied = (messages: Thread["messages"], messagesBefore = 0) => fire(coordinated({ messages }, {}, { activeRuns: { lead: activeRun("lead", { messagesBefore }) } }), { type: "run.status", status: "succeeded" }, "lead");
  const update = replied([createSentMessage({ text: "How are the threads doing?" }), createConversationMessage("assistant", "## Two of three threads are done\n\nFix login opened #212.")]);
  assert.deepEqual(headlines(update.effects), ["Two of three threads are done"], "the first line, without its heading marks");
  assert.deepEqual(titles(update.effects), ["Release"]);
  const marked = (text: string) => headlines(replied([createConversationMessage("assistant", text)]).effects)[0];
  assert.equal(marked("**Status:** two of three threads are _done_, see [PR #212](https://example.com/212)"), "Status: two of three threads are done, see PR #212", "read as plain words");
  assert.equal(marked("> - Fix `parse_args` in my_module"), "Fix parse_args in my_module", "quote, list and code marks go, a word's underscores stay");
  assert.equal(marked("```ts\nconst ready = true;"), "const ready = true;", "a bare fence says nothing");
  assert.equal(marked("---\n\n1. Merged the login fix"), "Merged the login fix", "nor does a rule");

  const long = "Everything is merged ".repeat(10).trim();
  const [clipped] = headlines(replied([createConversationMessage("assistant", long)]).effects);
  assert.equal(clipped.length, 120);
  assert.ok(clipped.endsWith("…") && long.startsWith(clipped.slice(0, -1)));

  const silent = replied([createConversationMessage("assistant", "An earlier answer"), createSentMessage({ text: "Carry on" })], 1);
  assert.deepEqual(headlines(silent.effects), ["The run finished."], "a turn that replied nothing says only that it finished, never an older reply");
});

test("a member's turn the coordinator started is not announced, but one the user started is, and failing, being blocked, or waiting on the user always is", () => {
  const started = coordinated();
  assert.deepEqual(headlines(fire(started, { type: "run.status", status: "succeeded" }).effects), [], "the coordinator's reply speaks for it");
  const messaged = coordinated({}, { messages: [createSentMessage({ text: "Fix it" }), createSentMessage({ text: "Also the signup test", origin: FROM_LEAD })] });
  assert.deepEqual(headlines(fire(messaged, { type: "run.status", status: "succeeded" }).effects), [], "nor a turn a later message from the coordinator started");

  const asked = coordinated({}, { messages: [createSentMessage({ text: "Fix it", origin: FROM_LEAD }), createSentMessage({ text: "Why is it still red?" })] });
  const answered = fire(asked, { type: "run.status", status: "succeeded" });
  assert.deepEqual(headlines(answered.effects), ["The run finished."], "the user's own words to it are theirs to hear back on");
  assert.deepEqual(titles(answered.effects), ["Release · Fix login"], "named under its coordinator");

  assert.deepEqual(headlines(fire(started, { type: "run.status", status: "failed", message: "The tool crashed" }).effects), ["The tool crashed"]);
  assert.deepEqual(headlines(fire(started, APPROVAL).effects), ["Waiting for your permission to use Bash"]);

  const blocked = reduce(started, { type: "coordination.reported", taskId: "task-a", state: "blocked", summary: "No access to the staging database" });
  assert.deepEqual(headlines(blocked.effects), ["Blocked: No access to the staging database"]);
  assert.deepEqual(titles(blocked.effects), ["Release · Fix login"]);
  assert.deepEqual(headlines(reduce(started, { type: "coordination.reported", taskId: "task-a", state: "failed", summary: "The fixture is gone" }).effects), ["Failed: The fixture is gone"]);
  assert.deepEqual(headlines(reduce(started, { type: "coordination.reported", taskId: "task-a", state: "done", summary: "PR #212" }).effects), [], "done is the coordinator's to say");
  assert.deepEqual(headlines(reduce(started, { type: "coordination.reported", taskId: "task-a", state: "working", summary: "Halfway" }).effects), []);

  const decided = reduce(started, { type: "coordination.decision-raised", taskId: "task-a", request: { question: "Ship it?", options: [] } });
  assert.deepEqual(headlines(decided.effects), ["Needs you: Ship it?"]);
  assert.deepEqual(titles(decided.effects), ["Release"], "a decision is the coordinator's to put to the user");
});

test("a muted coordinator announces nothing from itself or its threads, and is still marked", () => {
  const unmuted = coordinated({ messages: [createConversationMessage("assistant", "All done")] }, { messages: [createSentMessage({ text: "Why is it red?" })] });
  const muted = reduce(unmuted, { type: "coordination.set-muted", taskId: "lead", muted: true }).state;
  assert.equal(muted.threads[0].muted, true);

  const posted = fire(muted, { type: "run.status", status: "succeeded" }, "lead");
  assert.deepEqual(headlines(posted.effects), []);
  assert.equal(posted.state.threads[0].outcomeUnread, true, "the sidebar still says so");
  assert.deepEqual(headlines(fire(muted, { type: "run.status", status: "succeeded" }).effects), []);
  assert.deepEqual(headlines(fire(muted, { type: "run.status", status: "failed", message: "The tool crashed" }).effects), []);
  assert.deepEqual(headlines(fire(muted, APPROVAL).effects), []);
  assert.deepEqual(headlines(reduce(muted, { type: "coordination.reported", taskId: "task-a", state: "blocked", summary: "No access" }).effects), []);
  assert.deepEqual(headlines(reduce(muted, { type: "coordination.decision-raised", taskId: "task-a", request: { question: "Ship it?", options: [] } }).effects), []);

  const unmutedAgain = reduce(muted, { type: "coordination.set-muted", taskId: "lead", muted: false }).state;
  assert.equal(unmutedAgain.threads[0].muted, undefined);
  assert.deepEqual(headlines(fire(unmutedAgain, { type: "run.status", status: "succeeded" }, "lead").effects), ["All done"]);

  const alone = { ...unmuted, threads: [{ ...unmuted.threads[0], muted: true as const }, task("task-a", { title: "Fix login" })] };
  assert.deepEqual(titles(fire(alone, { type: "run.status", status: "succeeded" }).effects), ["Fix login"], "a thread moved out of a muted coordinator is heard again");
});

test("turning notifications off still wins over a coordinator and its threads", () => {
  const silent = coordinated({ messages: [createConversationMessage("assistant", "All done")] }, {}, { notifications: false });
  assert.deepEqual(headlines(fire(silent, { type: "run.status", status: "succeeded" }, "lead").effects), []);
  assert.deepEqual(headlines(fire(silent, { type: "run.status", status: "failed", message: "The tool crashed" }).effects), []);
  assert.deepEqual(headlines(reduce(silent, { type: "coordination.reported", taskId: "task-a", state: "blocked", summary: "No access" }).effects), []);
});
