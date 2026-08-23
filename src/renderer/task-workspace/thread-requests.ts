import { browserTarget, dockFor, dockOwner, terminalTarget, type WorkspaceState } from "../../application/workspace-state";
import { resolveScope, threadBusy, threadSummaries, threadSummary, threadTranscript, threadWaitResult } from "../../application/thread-projection";
import { findingOutcome, scheduledRun, unreadFindings } from "../../application/findings";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { FindingReport, FindingResult, ThreadRequest, ThreadResponse } from "../../contracts/threads";
import { terminalLineLimit } from "../../domain/terminal";
import { errorMessage } from "./errors";

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
  const settled = waiting.filter((waiter) => !threadBusy(state, waiter.threadId));
  if (!settled.length) return;
  waiters.current = waiting.filter((waiter) => !settled.includes(waiter));
  for (const waiter of settled) {
    window.clearTimeout(waiter.timer);
    waiter.settle(state);
  }
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
    /** A new thread with no project named belongs where the thread that asked for it lives. */
    const callerProjectId = before.tasks.find((task) => task.id === request.taskId)?.projectId;
    const targeted = command.type === "task.send" && command.taskId === undefined && command.project === undefined && callerProjectId
      ? { ...command, project: callerProjectId }
      : command;
    const known = new Set(before.tasks.map((task) => task.id));
    await host.dispatch(targeted);
    const after = host.state();
    const thread = command.taskId
      ? after.tasks.find((task) => task.id === command.taskId)
      : after.tasks.find((task) => !known.has(task.id));
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

/**
 * Records what a run found. The command goes in whatever the thread does with it, so a run that says
 * it found something can never afterwards be settled unseen; the answer explains what became of it.
 */
async function raiseFinding(host: ThreadRequestHost, taskId: string, report: FindingReport): Promise<FindingResult> {
  const before = host.state();
  const task = before.tasks.find((item) => item.id === taskId);
  if (!task || !scheduledRun(before, taskId)) return { recorded: false, note: UNSCHEDULED };
  const outcome = findingOutcome(task, report.key);
  await host.dispatch({ type: "automation.notify", taskId, ...report });
  if (outcome === "duplicate") return { recorded: false, note: `This thread already carries a finding keyed "${report.key}", so the same one was held back. Raising only what it already knows lets this run settle unseen.` };
  const unread = unreadCount(host, taskId);
  const carried = unread === 0
    ? "The user is looking at this thread, so it is already seen"
    : `This thread now carries ${unread} unread ${unread === 1 ? "finding" : "findings"}`;
  return { recorded: true, note: `Raised. ${carried}, and the run surfaces when it settles.` };
}

/** A run saying it looked and found nothing, which is the only thing that earns a quiet tick silence. */
async function reportNothing(host: ThreadRequestHost, taskId: string, checked: string): Promise<FindingResult> {
  const active = scheduledRun(host.state(), taskId);
  if (!active) return { recorded: false, note: UNSCHEDULED };
  await host.dispatch({ type: "automation.nothing-to-report", taskId, checked });
  if (active.notified) return { recorded: false, note: "This run already raised something new, so it surfaces anyway and what it found stands." };
  if (!active.quiet) return { recorded: true, note: "Noted. This automation has no quiet sentence, so every run of it surfaces, this one included." };
  return { recorded: true, note: "Noted. This run settles without reaching the user." };
}
