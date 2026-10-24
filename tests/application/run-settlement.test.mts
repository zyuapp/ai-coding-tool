import assert from "node:assert/strict";
import { test } from "vitest";
import { endsQuietly, settledEvent, settledTurn, settleTurn, withSettledTurn, type TurnEnd } from "../../src/application/run-settlement.ts";
import type { RunEvent } from "../../src/contracts/ipc.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { UsageLimit } from "../../src/domain/usage-limit.ts";
import { activeRun, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const at = 1_800_000_000_000;
const session: UsageLimit = { resetsAt: at + 3_600_000, window: "session" };
const weekly: UsageLimit = { resetsAt: at + 72 * 3_600_000, window: "weekly" };
const attended = { origin: "composer", quiet: false, acknowledged: false, notified: false } as const;
const tick = { origin: "automation", quiet: true, acknowledged: true, notified: false } as const;

const lead = (overrides: Partial<Thread> = {}) => task("lead", { role: "coordinator", title: "Lead", ...overrides });
const member = (id: string, overrides: Partial<Thread> = {}) => task(id, { parentId: "lead", title: id, ...overrides });
const notesOf = (state: { threads: Thread[] }) => required(state.threads.find((thread) => thread.id === "lead")).coordinationNotes ?? [];

test("an attended turn that ends leaves its verdict and is heard by its coordinator", () => {
  const settlement = settleTurn({ status: "succeeded", run: attended });
  assert.equal(settlement.status, "succeeded");
  assert.equal(settlement.surfacing, "attended");
  assert.equal(settlement.verdict, "finished");
  assert.equal(settlement.runEndedAs, "finished");
  assert.deepEqual(settlement.heard, { quiet: false });
  assert.equal(settlement.limit, null);
  assert.equal(settlement.withdraws, false);
  assert.equal(settlement.reopens, false);
  assert.equal(settleTurn({ status: "failed", run: attended }).reopens, true, "a failed turn may leave its thread stuck");
});

test("a turn of the user's own ends quietly unless it failed", () => {
  const usersOwn = { ...attended, usersOwn: true } as const;
  assert.deepEqual(settleTurn({ status: "succeeded", run: usersOwn }).heard, { quiet: true });
  assert.deepEqual(settleTurn({ status: "cancelled", run: usersOwn }).heard, { quiet: true });
  assert.deepEqual(settleTurn({ status: "failed", run: usersOwn }).heard, { quiet: false });
});

test("what Stop all stopped ends quietly once it has stopped, and answers the stop", () => {
  const stopped = settleTurn({ status: "cancelled", run: attended, stop: "stop-all" });
  assert.deepEqual(stopped.heard, { quiet: true });
  assert.equal(stopped.answersStopAll, true);
  assert.deepEqual(settleTurn({ status: "succeeded", run: attended, stop: "stop-all" }).heard, { quiet: false }, "one that finished first is news");
  assert.deepEqual(settleTurn({ status: "cancelled", run: attended, stop: "user" }).heard, { quiet: false }, "the user's own stop is heard as ever");
  assert.deepEqual(settleTurn({ status: "failed", run: { ...attended, answersStop: true } }).heard, { quiet: true }, "the agent's answer to the stop is quiet however it ends");
});

test("the quiet rule", () => {
  assert.equal(endsQuietly({ status: "succeeded" }), false);
  assert.equal(endsQuietly({ status: "failed", answersStop: true }), true);
  assert.equal(endsQuietly({ status: "cancelled", stop: "quit" }), true);
  assert.equal(endsQuietly({ status: "cancelled", stop: "stop-all" }), true);
  assert.equal(endsQuietly({ status: "failed", stop: "stop-all" }), false);
  assert.equal(endsQuietly({ status: "succeeded", usersOwn: true }), true);
  assert.equal(endsQuietly({ status: "failed", usersOwn: true }), false);
});

test("a turn that waits out a session limit carries on, so it leaves no verdict and is no news", () => {
  const settlement = settleTurn({ status: "failed", message: "You've hit your limit", limit: session, run: attended });
  assert.equal(settlement.status, "failed");
  assert.equal(settlement.surfacing, "failed");
  assert.equal(settlement.verdict, null);
  assert.equal(settlement.runEndedAs, null);
  assert.deepEqual(settlement.limit, { reached: session, waits: true });
  assert.equal(settlement.heard, null);
  assert.equal(settlement.reopens, false);
});

test("a weekly limit waits for the user and keeps its verdict to say so", () => {
  const settlement = settleTurn({ status: "failed", limit: weekly, run: attended });
  assert.equal(settlement.verdict, "failed");
  assert.equal(settlement.runEndedAs, "failed");
  assert.deepEqual(settlement.limit, { reached: weekly, waits: true });
  assert.deepEqual(settlement.heard, { quiet: false });
  assert.equal(settlement.reopens, true);
});

test("a turn being stopped that a limit got to first ends as the stop asked, still holding its engine", () => {
  const end: TurnEnd = { status: "failed", message: "You've hit your limit", limit: session, run: attended, stop: "user" };
  const settlement = settleTurn(end);
  assert.equal(settlement.status, "cancelled");
  assert.equal(settlement.message, undefined);
  assert.equal(settlement.verdict, "stopped");
  assert.deepEqual(settlement.limit, { reached: session, waits: false });
  assert.deepEqual(settlement.heard, { quiet: false });
  const weeklyStop = settleTurn({ ...end, limit: weekly });
  assert.equal(weeklyStop.status, "failed", "a weekly limit is said as the failure it is");
  assert.equal(weeklyStop.message, "You've hit your limit");
  assert.deepEqual(weeklyStop.limit, { reached: weekly, waits: false });

  const event: Extract<RunEvent, { type: "run.status" }> = { type: "run.status", taskId: "a", runId: "run-a", sequence: 1, status: "failed", message: "You've hit your limit", limit: session };
  assert.deepEqual(settledEvent(event, settlement), { type: "run.status", taskId: "a", runId: "run-a", sequence: 1, status: "cancelled" });
  assert.equal(settledEvent(event, weeklyStop), event);
});

test("a quiet tick that answered and found nothing earns its silence", () => {
  const settlement = settleTurn({ status: "succeeded", run: tick, stop: "stop-all" });
  assert.equal(settlement.surfacing, null);
  assert.equal(settlement.verdict, null);
  assert.equal(settlement.withdraws, true);
  assert.equal(settlement.closesIssues, true);
  assert.equal(settlement.heard, null);
  assert.equal(settlement.answersStopAll, false);
  assert.equal(settleTurn({ status: "succeeded", run: { ...tick, notified: true } }).surfacing, "reported");
  assert.equal(settleTurn({ status: "failed", run: tick }).closesIssues, false);
});

test("compacting is no turn: it puts back what the last one left and is no news", () => {
  const settlement = settleTurn({ status: "succeeded", run: { ...attended, operation: "compact" } });
  assert.equal(settlement.restoresTestimony, true);
  assert.equal(settlement.verdict, null);
  assert.equal(settlement.heard, null);
  assert.equal(settlement.limit, null);
  const before = { updatedAt: 1, runEndedAs: "failed" as const, outcome: "failed" as const, runEndedAt: 5 };
  const state = workspace({ threads: [task("a", { runEndedAs: "finished", runEndedAt: 9, outcome: "finished", outcomeUnread: true })] });
  const restored = required(withSettledTurn(state, "a", settlement, activeRun("a", "run-a", { operation: "compact", before }), at).threads[0]);
  assert.deepEqual([restored.runEndedAs, restored.runEndedAt, restored.outcome, restored.outcomeUnread], ["failed", 5, "failed", undefined]);
});

test("a turn cut off with the app reads as stopped and is heard quietly, and a coordinator cut off hushes its news", () => {
  const settlement = settleTurn({ status: "cancelled", stop: "quit" });
  assert.equal(settlement.verdict, "stopped");
  assert.equal(settlement.runEndedAs, "stopped");
  assert.deepEqual(settlement.heard, { quiet: true });
  assert.equal(settlement.hushesNews, true);
  const loud = { id: "n", threadId: "x", text: "x", at: 1 };
  const state = workspace({ threads: [lead({ coordinationNotes: [loud] }), member("one")] });
  const ended = withSettledTurn(withSettledTurn(state, "lead", settlement, undefined, at), "one", settlement, undefined, at);
  assert.equal(notesOf(ended).every((note) => note.quiet), true);
  assert.equal(notesOf(ended).length, 2);
  assert.equal(required(ended.threads.find((thread) => thread.id === "one")).outcome, "stopped");
});

test("a thread kept from carrying on in line ends as one the user stopped, heard in the same words, its queue handed back", () => {
  const settlement = settleTurn({ status: "cancelled", stop: "user" });
  assert.equal(settlement.surfacing, "cancelled");
  assert.equal(settlement.verdict, "stopped");
  assert.deepEqual(settlement.heard, { quiet: false });
  const state = workspace({
    threads: [lead(), member("one")],
    queuedMessages: { one: [{ id: "q", text: "later", prompt: "later", attachments: [], usersOwn: true }] },
  });
  const ended = settledTurn(state, "one", settlement, undefined, at);
  const note = required(notesOf(ended.state).at(-1));
  assert.equal(note.text, "\"one\" was stopped.");
  assert.equal(note.quiet, undefined);
  assert.equal(ended.state.queuedMessages.one?.length ?? 0, 0);
  assert.equal(ended.state.prompts.one, "later");
});

test("a settled run applied: a session limit puts its thread in line without its verdict, and a failure reopens a stuck thread", () => {
  const state = workspace({ threads: [task("a", { runEndedAs: "failed", outcome: "finished" }), task("b", { runEndedAs: "failed", resolvedAt: 1 })] });
  const paused = withSettledTurn(state, "a", settleTurn({ status: "failed", limit: session, run: attended }), activeRun("a", "run-a"), at);
  const thread = required(paused.threads.find((item) => item.id === "a"));
  assert.deepEqual([thread.outcome, thread.runEndedAs, thread.limitPause], [undefined, undefined, { ...session, pausedAt: at }]);
  const reopened = withSettledTurn(state, "b", settleTurn({ status: "failed", run: attended }), activeRun("b", "run-b"), at);
  assert.equal(required(reopened.threads.find((item) => item.id === "b")).resolvedAt, undefined);
});
