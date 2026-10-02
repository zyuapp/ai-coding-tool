import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { reduce, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { threadBusy, threadSummary } from "../../src/application/thread-projection.ts";
import { isRunEvent } from "../../src/contracts/ipc.ts";
import { isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { parseThreadStore, serializeThreadStore } from "../../src/domain/thread-storage.ts";
import { pauseSummary, type UsageLimit } from "../../src/domain/usage-limit.ts";
import { activeRun, correlatedRunEvent, effectOf, PROJECT, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const at = 1_800_000_000_000;
const HOUR = 3_600_000;
const session: UsageLimit = { resetsAt: at + 2 * HOUR, window: "session" };
const weekly: UsageLimit = { resetsAt: at + 72 * HOUR, window: "weekly" };
const resolution = { id: PROJECT.workspaceId!, kind: "project" as const, root: PROJECT.root };

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(at); });
afterEach(() => { vi.restoreAllMocks(); });

function runningThreads(...ids: string[]): WorkspaceState {
  return workspace({
    projects: [PROJECT],
    threads: ids.map((id) => task(id, { projectId: PROJECT.id })),
    currentId: ids[0],
    activeRuns: Object.fromEntries(ids.map((id) => [id, activeRun(id, `run-${id}`)])),
    runStatuses: Object.fromEntries(ids.map((id) => [id, "running" as const])),
  });
}

function limited(state: WorkspaceState, taskId: string, limit: UsageLimit, sequence = 1): WorkspaceTransition {
  const runId = state.activeRuns[taskId]!.runId;
  return reduce(state, correlatedRunEvent(taskId, runId, sequence, { type: "run.status", status: "failed", message: "You've hit your limit", limit }));
}

function thread(state: WorkspaceState, id: string) {
  return required(state.threads.find((item) => item.id === id));
}

/** Answers every workspace request the transition asked for, the way the host does. */
function resolveAll(transition: WorkspaceTransition): WorkspaceTransition {
  let current = transition;
  for (const effect of transition.effects) {
    if (effect.type !== "resolve-run-workspace") continue;
    current = reduce(current.state, { type: "run.resolved", pendingId: effect.pendingId, workspace: resolution });
  }
  return current;
}

test("a session limit pauses the thread in line and wakes up when the limit lifts", () => {
  const paused = limited(runningThreads("a"), "a", session);
  const pause = required(thread(paused.state, "a").limitPause);
  assert.equal(pause.resetsAt, session.resetsAt);
  assert.equal(thread(paused.state, "a").outcome, undefined, "a limit that lifts on its own is not a failure to look at");
  assert.deepEqual(effectOf(paused, "schedule-limit-reset"), { type: "schedule-limit-reset", at: session.resetsAt });
  assert.equal(threadBusy(paused.state, "a"), true, "a wait on the thread keeps waiting through the pause");
  assert.equal(threadSummary(paused.state, thread(paused.state, "a")).status, "running");
  assert.equal(threadSummary(paused.state, thread(paused.state, "a")).pausedUntil, session.resetsAt);
  assert.equal(deriveView(paused.state).limitPause?.position, 1);

  const early = reduce(paused.state, { type: "limits.elapsed", at: session.resetsAt - 1 });
  assert.equal(early.effects.some((effect) => effect.type === "resolve-run-workspace"), false);

  const woke = resolveAll(reduce(paused.state, { type: "limits.elapsed", at: session.resetsAt }));
  assert.equal(thread(woke.state, "a").limitPause, undefined);
  const start = effectOf(woke, "start-run");
  assert.match(start.command.prompt, /usage limit that paused this thread has reset/);
  assert.equal(thread(woke.state, "a").messages.at(-1)?.text, "Usage limit reset. Resuming.");
  assert.equal(woke.state.activeRuns.a?.warming, true);
});

test("threads resume one at a time, each after the one before has answered once", () => {
  let state = limited(runningThreads("a", "b"), "a", session).state;
  state = limited(state, "b", session).state;
  assert.equal(deriveView(state).limitPositions.get("b"), 2);
  assert.equal(pauseSummary(thread(state, "b").limitPause!, 2, at), `Resumes ${new Date(session.resetsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · 2nd`);

  vi.mocked(Date.now).mockReturnValue(session.resetsAt);
  const first = resolveAll(reduce(state, { type: "limits.elapsed", at: session.resetsAt }));
  assert.ok(first.state.activeRuns.a, "the first in line starts");
  assert.ok(thread(first.state, "b").limitPause, "the second waits for it");

  const runId = first.state.activeRuns.a!.runId;
  const warmed = resolveAll(reduce(first.state, correlatedRunEvent("a", runId, 1, { type: "context.usage", tokens: 10, limit: 100, model: "claude" })));
  assert.equal(warmed.state.activeRuns.a?.warming, undefined);
  assert.ok(warmed.state.activeRuns.b, "the next in line goes once the first has answered");
  assert.equal(thread(warmed.state, "b").limitPause, undefined);
});

test("writing to a paused thread holds the message and moves the thread to the front", () => {
  let state = limited(runningThreads("a", "b"), "a", session).state;
  state = limited(state, "b", session).state;
  state = reduce({ ...state, currentId: "b" }, { type: "view.set-prompt", prompt: "also fix the tests" }).state;
  const sent = reduce(state, { type: "task.send", attachments: [] });
  assert.equal(sent.effects.some((effect) => effect.type === "resolve-run-workspace"), false, "the message waits for the limit");
  assert.equal(sent.state.queuedMessages.b?.[0]?.text, "also fix the tests");
  assert.equal(sent.state.prompts.b ?? "", "");
  assert.equal(deriveView(sent.state).limitPositions.get("b"), 1);

  const woke = resolveAll(reduce(sent.state, { type: "limits.elapsed", at: session.resetsAt }));
  assert.ok(woke.state.activeRuns.b, "the thread written to goes first");
  assert.equal(effectOf(woke, "start-run").command.prompt, "also fix the tests");
  assert.equal(thread(woke.state, "b").messages.at(-1)?.text, "also fix the tests");
  assert.equal(woke.state.activeRuns.b?.warming, true);
  assert.equal(woke.state.activeRuns.a, undefined);
});

test("the thread written to last goes first, and a send after the reset still waits its turn", () => {
  let state = limited(runningThreads("a", "b", "c"), "a", session).state;
  state = limited(state, "b", session).state;
  state = limited(state, "c", session).state;
  const write = (current: WorkspaceState, taskId: string, text: string) => reduce(current, { type: "task.send", taskId, text, attachments: [] });
  state = write(state, "a", "first").state;
  vi.mocked(Date.now).mockReturnValue(at + 1);
  state = write(state, "b", "second").state;
  assert.deepEqual(["b", "a", "c"].map((id) => deriveView(state).limitPositions.get(id)), [1, 2, 3]);
  vi.mocked(Date.now).mockReturnValue(at + 2);
  state = write(state, "a", "again").state;
  assert.equal(deriveView(state).limitPositions.get("a"), 1, "writing again moves it forward, never back");

  vi.mocked(Date.now).mockReturnValue(session.resetsAt);
  const woke = resolveAll(reduce(state, { type: "limits.elapsed", at: session.resetsAt }));
  assert.ok(woke.state.activeRuns.a?.warming);
  const late = write(woke.state, "c", "now please");
  assert.equal(late.effects.some((effect) => effect.type === "resolve-run-workspace"), false, "it waits for the thread warming up");
  assert.equal(late.state.queuedMessages.c?.[0]?.text, "now please");
  assert.ok(thread(late.state, "c").limitPause);
});

test("a weekly limit keeps its verdict and waits for the user to resume", () => {
  const paused = limited(runningThreads("a"), "a", weekly);
  assert.equal(thread(paused.state, "a").outcome, "failed");
  assert.equal(paused.effects.some((effect) => effect.type === "schedule-limit-reset"), false, "nothing resumes on its own");
  const later = reduce(paused.state, { type: "limits.elapsed", at: weekly.resetsAt + 1 });
  assert.ok(thread(later.state, "a").limitPause);
  assert.match(pauseSummary(thread(paused.state, "a").limitPause!, null, at), /^Weekly limit · resets /);

  const input = { type: "limit.resume", taskId: "a" } as const;
  assert.equal(isWorkspaceViewInput(input), true);
  const resumed = resolveAll(reduce(paused.state, input));
  assert.ok(resumed.state.activeRuns.a);
  assert.equal(thread(resumed.state, "a").limitPause, undefined);
});

test("a limit holds every thread of the engine waiting on an earlier reset", () => {
  let state = limited(runningThreads("a", "b"), "a", session).state;
  state = limited(state, "b", weekly).state;
  assert.equal(thread(state, "a").limitPause?.resetsAt, weekly.resetsAt);
  assert.equal(thread(state, "a").limitPause?.window, "weekly");
});

test("not resuming hands what was written back to the composer", () => {
  let state = limited(runningThreads("a"), "a", session).state;
  state = reduce(state, { type: "view.set-prompt", prompt: "later" }).state;
  state = reduce(state, { type: "task.send", attachments: [] }).state;
  const input = { type: "limit.cancel", taskId: "a" } as const;
  assert.equal(isWorkspaceViewInput(input), true);
  const cancelled = reduce(state, input);
  assert.equal(thread(cancelled.state, "a").limitPause, undefined);
  assert.equal(cancelled.state.queuedMessages.a, undefined);
  assert.equal(cancelled.state.prompts.a, "later");
  assert.equal(effectOf(cancelled, "schedule-limit-reset").at, null);
  assert.equal(reduce(cancelled.state, { type: "limits.elapsed", at: session.resetsAt }).state.activeRuns.a, undefined);
  const held = reduce(limited(runningThreads("a"), "a", session).state, { type: "task.send", taskId: "a", text: "held", attachments: [] }).state;
  const archived = reduce(held, { type: "task.archive", taskId: "a" });
  assert.equal(thread(archived.state, "a").limitPause, undefined);
  assert.equal(archived.state.queuedMessages.a, undefined);
  assert.equal(archived.state.prompts.a, "held");
  assert.equal(threadBusy(archived.state, "a"), false);
});

test("a cut-short workflow is resumed rather than restarted, and goes after the others", () => {
  let state = runningThreads("a", "b");
  state = { ...state, workflows: { a: [{ id: "wf", name: "wf", description: "Dynamic workflow", status: "running", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 }] } };
  state = limited(state, "a", session).state;
  state = limited(state, "b", session).state;
  assert.equal(thread(state, "a").limitPause?.workflow, true);
  assert.equal(deriveView(state).limitPositions.get("a"), 2);
  vi.mocked(Date.now).mockReturnValue(session.resetsAt);
  const woke = resolveAll(reduce(state, { type: "limits.elapsed", at: session.resetsAt }));
  assert.ok(woke.state.activeRuns.b);
  const runId = woke.state.activeRuns.b!.runId;
  const next = resolveAll(reduce(woke.state, correlatedRunEvent("b", runId, 1, { type: "context.usage", tokens: 1, limit: 2, model: "claude" })));
  assert.match(effectOf(next, "start-run").command.prompt, /resumeFromRunId/);

  let written: WorkspaceState = { ...runningThreads("w"), workflows: { w: [{ id: "wf", name: "wf", description: "Dynamic workflow", status: "running" as const, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 }] } };
  vi.mocked(Date.now).mockReturnValue(at);
  written = limited(written, "w", session).state;
  written = reduce(written, { type: "task.send", taskId: "w", text: "check the results", attachments: [] }).state;
  vi.mocked(Date.now).mockReturnValue(session.resetsAt);
  const prompt = effectOf(resolveAll(reduce(written, { type: "limits.elapsed", at: session.resetsAt })), "start-run").command.prompt;
  assert.match(prompt, /^check the results\n\n.*resumeFromRunId/s, "a message written while it waited keeps the workflow's instruction");
});

test("a pause survives a restart, and a run that reports a limit is checked", () => {
  const paused = limited(runningThreads("a"), "a", session).state;
  const parsed = parseThreadStore(serializeThreadStore({ version: 2, projects: [PROJECT], worktrees: [], lastFolder: null, tasks: paused.threads }));
  assert.ok(parsed.ok);
  const restored = parsed.data;
  assert.deepEqual(restored.tasks[0]?.limitPause, thread(paused, "a").limitPause);
  const event = { type: "run.status", taskId: "a", runId: "r", sequence: 1, status: "failed", limit: session };
  assert.equal(isRunEvent(event), true);
  assert.equal(isRunEvent({ ...event, status: "succeeded" }), false);
  assert.equal(isRunEvent({ ...event, limit: { resetsAt: "soon", window: "session" } }), false);
  const loaded = reduce(workspace({ threads: [] }), { type: "store.loaded", data: restored });
  assert.deepEqual(effectOf(loaded, "schedule-limit-reset"), { type: "schedule-limit-reset", at: session.resetsAt });
});
