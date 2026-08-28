import { browserTarget, dockFor, dockOwner, terminalTarget, type WorkspaceState } from "../../application/workspace-state";
import { resolveScope, threadBusy, threadSummaries, threadSummary, threadTranscript, threadWaitResult } from "../../application/thread-projection";
import { isNews, unreadFindings } from "../../domain/attention";
import { scheduledRun } from "../../application/run-testimony";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { FindingReport, FindingResult, ThreadRequest, ThreadResponse } from "../../contracts/threads";
import { terminalLineLimit } from "../../domain/terminal";
import { errorMessage } from "./errors";
import { defaultEffortFor, defaultModelFor, engineForModel, engineHasEffort } from "../../domain/agent-engine";

/** How much page text a read returns when the caller does not say. */
const DEFAULT_PAGE_TEXT = 4_000;

/** A tool call held open until the thread it names stops working. */
export type ThreadWaiter = {
  threadId: string;
  settle: (state: WorkspaceState) => void;
  timer: number;
};

export type ThreadWaiterList = { current: ThreadWaiter[] };

/** The window's own state and door into the reducer, which is all answering a request takes. */
export type ThreadRequestHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void> | void;
  waiters: ThreadWaiterList;
};

/** A thread being waited on has settled, so the waiting tool call can answer. */
export function releaseThreadWaiters(waiters: ThreadWaiterList, state: WorkspaceState) {
  const waiting = waiters.current;
  if (!waiting.length) return;
  let pending: ThreadWaiter[] | null = null;
  for (let index = 0; index < waiting.length; index += 1) {
    const waiter = waiting[index]!;
    if (threadBusy(state, waiter.threadId)) {
      pending?.push(waiter);
    } else {
      pending ??= waiting.slice(0, index);
      window.clearTimeout(waiter.timer);
      waiter.settle(state);
    }
  }
  if (pending) waiters.current = pending;
}

/**
 * The window is the only holder of workspace state, so it answers thread requests itself: reads
 * come from the projection, and writes go through the same reducer the UI dispatches into.
 */
export async function answerThreadRequest(host: ThreadRequestHost, request: ThreadRequest): Promise<ThreadResponse> {
  const requestId = request.requestId;
  const ok = (result: unknown): ThreadResponse => ({ type: "thread.response", requestId, ok: true, result });
  const failed = (message: string): ThreadResponse => ({ type: "thread.response", requestId, ok: false, message });
  try {
    if (request.op === "list") {
      const scope = resolveScope(host.state(), request.taskId, request.project);
      if ("error" in scope) return failed(scope.error);
      return ok(threadSummaries(host.state(), {
        scope,
        ...(request.archived === undefined ? {} : { archived: request.archived }),
        ...(request.idleForMs === undefined ? {} : { idleForMs: request.idleForMs }),
        ...(request.search === undefined ? {} : { search: request.search }),
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }, Date.now()));
    }
    if (request.op === "read") {
      const transcript = threadTranscript(host.state(), request.threadId, request.limit);
      return transcript ? ok(transcript) : failed(`No thread has the ID ${request.threadId}.`);
    }
    if (request.op === "wait") {
      const waited = threadWaitResult(host.state(), request.threadId, false);
      if (!waited) return failed(`No thread has the ID ${request.threadId}.`);
      if (!threadBusy(host.state(), request.threadId)) return ok(waited);
      return new Promise<ThreadResponse>((resolve) => {
        const waiter: ThreadWaiter = {
          threadId: request.threadId,
          settle: (state) => resolve(ok(threadWaitResult(state, request.threadId, false))),
          timer: window.setTimeout(() => {
            host.waiters.current = host.waiters.current.filter((item) => item !== waiter);
            resolve(ok(threadWaitResult(host.state(), request.threadId, true)));
          }, request.timeoutMs),
        };
        host.waiters.current.push(waiter);
      });
    }
    if (request.op === "browser") {
      const state = host.state();
      if (state.browserApproval?.taskId === request.taskId) return ok({ kind: "awaiting-approval", url: state.browserApproval.url });
      /** A run reaches its own thread's dock, whichever dock the user has on screen. */
      const dock = dockFor(state, dockOwner(state, request.taskId));
      if (request.read.op === "tabs") return ok({ kind: "tabs", tabs: dock.browserTabs });
      const tab = browserTarget(dock, request.read.tabId);
      if (!tab) return ok({ kind: "no-tab" });
      const snapshot = await window.desktop.readBrowserPage(tab.id, request.read.textLimit ?? DEFAULT_PAGE_TEXT, request.read.timeoutMs);
      return snapshot ? ok({ kind: "snapshot", snapshot }) : ok({ kind: "no-tab" });
    }
    if (request.op === "terminal") {
      const state = host.state();
      const dock = dockFor(state, dockOwner(state, request.taskId));
      if (request.read.op === "terminals") return ok({ kind: "terminals", terminals: dock.terminals });
      const terminal = terminalTarget(dock, request.read.terminalId, request.taskId);
      if (!terminal) return ok({ kind: "no-terminal" });
      const text = await window.desktop.readTerminal(terminal.id, {
        lines: terminalLineLimit(request.read.lines),
        ...(request.read.match ? { match: request.read.match } : {}),
      });
      if (!text) return ok({ kind: "no-terminal" });
      const { taskId: _thread, id: _id, ...record } = terminal;
      return ok({ kind: "snapshot", snapshot: { terminalId: terminal.id, ...record, ...text } });
    }
    if (request.op === "notify") return ok(await raiseFinding(host, request.taskId, request.report));
    if (request.op === "nothing-to-report") return ok(await reportNothing(host, request.taskId, request.checked));
    const { command } = request;
    const before = host.state();
    /** A browser command acts on a tab rather than a thread, so it answers with the panel's own error. */
    if (command.type.startsWith("browser.")) {
      await host.dispatch(command);
      const acted = host.state();
      return acted.actionError && acted.actionError !== before.actionError ? failed(acted.actionError) : ok({ thread: null });
    }
    if (command.taskId !== undefined && !before.tasks.some((task) => task.id === command.taskId)) {
      return failed(`No thread has the ID ${command.taskId}.`);
    }
    const caller = before.tasks.find((task) => task.id === request.taskId);
    if (command.type === "task.send" && command.taskId === undefined && !caller) {
      return failed(`No thread has the ID ${request.taskId}.`);
    }
    const selected: { command: typeof command } | { error: string } = command.type === "task.send" && command.taskId === undefined && caller
      ? (() => {
          const model = command.model ?? caller.model ?? defaultModelFor(caller.engine);
          const engine = engineForModel(model);
          const inheritedEffort = caller.effort ?? defaultEffortFor(caller.engine);
          const effort = command.effort ?? (engineHasEffort(engine, inheritedEffort) ? inheritedEffort : defaultEffortFor(engine));
          return engineHasEffort(engine, effort)
            ? { command: { ...command, model, effort } }
            : { error: `The ${model} model does not support ${effort} effort.` };
        })()
      : { command };
    if ("error" in selected) return failed(selected.error);
    /** A new thread with no project named belongs where the thread that asked for it lives. */
    const callerProjectId = caller?.projectId;
    const targeted = selected.command.type === "task.send" && selected.command.taskId === undefined && selected.command.project === undefined && callerProjectId
      ? { ...selected.command, project: callerProjectId }
      : selected.command;
    const known = command.taskId === undefined ? new Set(before.tasks.map((task) => task.id)) : null;
    await host.dispatch(targeted);
    const after = host.state();
    const thread = command.taskId
      ? after.tasks.find((task) => task.id === command.taskId)
      : after.tasks.find((task) => !known!.has(task.id));
    if (!thread && after.actionError && after.actionError !== before.actionError) return failed(after.actionError);
    return ok({ thread: thread ? threadSummary(after, thread) : null });
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/** What the tools say when the caller is not a scheduled run at all. Nothing is written for one. */
const UNSCHEDULED = "This turn is not a scheduled run, so there is nothing to surface or to silence and nothing was recorded. Say what you found in your reply instead; these two tools are only for a run the automation's schedule started.";

function unreadCount(host: ThreadRequestHost, taskId: string) {
  const task = host.state().tasks.find((item) => item.id === taskId);
  return task ? unreadFindings(task).length : 0;
}

/** The newest finding a thread carries, named so two reads of it can be compared. */
function newestFindingId(state: WorkspaceState, taskId: string) {
  return state.tasks.find((task) => task.id === taskId)?.findings?.at(-1)?.id;
}

/** A run the user answered or steered into is theirs from then on, and what it finds answers them. */
const TAKEN_OVER = "The user joined this run while the report was going in, so it is theirs to answer now and nothing was recorded. Tell them what you found in your reply instead.";

/**
 * Records what a run found. The command goes in whatever the thread does with it, so a run that
 * raises an issue the thread has not heard of can never afterwards be settled unseen.
 *
 * The answer reports what the thread did, read back after the fact: predicting it from the state
 * beforehand told the run its report was raised in the very cases the thread went on to drop it.
 */
async function raiseFinding(host: ThreadRequestHost, taskId: string, report: FindingReport): Promise<FindingResult> {
  const before = host.state();
  const task = before.tasks.find((item) => item.id === taskId);
  if (!task || !scheduledRun(before, taskId)) return { recorded: false, note: UNSCHEDULED };
  const known = !isNews(task, report.key);
  const newestBefore = newestFindingId(before, taskId);
  await host.dispatch({ type: "automation.notify", taskId, ...report });
  if (newestFindingId(host.state(), taskId) === newestBefore) {
    if (known) return { recorded: false, note: `This thread already carries a finding keyed "${report.key}", so the same one was held back. Raising only what it already knows lets this run settle unseen.` };
    return { recorded: false, note: TAKEN_OVER };
  }
  const unread = unreadCount(host, taskId);
  const carried = unread === 0
    ? "The user is looking at this thread, so it is already seen"
    : `This thread now carries ${unread} unread ${unread === 1 ? "finding" : "findings"}`;
  return { recorded: true, note: `Raised. ${carried}, and the run surfaces when it settles.` };
}

/** A run saying it looked and found nothing: it answers for the tick without raising anything, which is what leaves a quiet one its silence. */
async function reportNothing(host: ThreadRequestHost, taskId: string, checked: string): Promise<FindingResult> {
  const active = scheduledRun(host.state(), taskId);
  if (!active) return { recorded: false, note: UNSCHEDULED };
  await host.dispatch({ type: "automation.nothing-to-report", taskId, checked });
  if (active.notified) return { recorded: false, note: "This run already raised something new, so it surfaces anyway and what it found stands." };
  if (!active.quiet) return { recorded: true, note: "Noted. This automation has no quiet sentence, so every run of it surfaces, this one included." };
  return { recorded: true, note: "Noted. This run settles without reaching the user." };
}
