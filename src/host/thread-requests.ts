import { browserPermissions } from "../application/workspace-reducer.js";
import { browserTarget, dockFor, dockOwner, terminalTarget, type WorkspaceState } from "../application/workspace-state.js";
import { threadSummary, threadWaitResult } from "../application/thread-projection.js";
import { isWorking } from "../application/thread-activity.js";
import { listAcrossComputers, namedComputer, online, readAcrossComputers, remoteSummary, resolveThreadRead, tag, type PreparedThreadRequest } from "./thread-reads.js";
import type { PairedComputer } from "../application/computers.js";
import { findProject, folderName, matchingProjects, projectName, type Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { isNews, unreadFindings } from "../domain/attention.js";
import { scheduledRun } from "../application/run-testimony.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { AppCommand } from "../contracts/commands.js";
import type { ExternalCommand, FindingReport, FindingResult, ThreadCommandResult, ThreadRequest, ThreadResponse } from "../contracts/threads.js";
import { terminalLineLimit } from "../domain/terminal.js";
import { coordinatorOf, isCoordinator, type CoordinationState, type DecisionRequest } from "../domain/coordination.js";
import { errorMessage } from "./errors.js";
import type { RuntimeDesktop } from "./runtime-desktop.js";
import { defaultEffortFor, defaultModelFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../domain/agent-engine.js";

/** How much page text a read returns when the caller does not say. */
const DEFAULT_PAGE_TEXT = 4_000;

/** A tool call held open until the state it waits on arrives, such as the thread it names stopping work. */
export type ThreadWaiter = {
  pending: (state: WorkspaceState) => boolean;
  settle: (state: WorkspaceState) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ThreadWaiterList = { current: ThreadWaiter[] };

/** The runtime state and the command execution that answers each tool request. */
export type ThreadRequestHost = {
  state: () => WorkspaceState;
  desktop: Pick<RuntimeDesktop, "configureBrowserPermissions" | "captureBrowserPage" | "inspectBrowserPage" | "readBrowserPage" | "readTerminal" | "queryComputerThreads">;
  dispatch: (input: WorkspaceInput) => Promise<void> | void;
  execute: (command: AppCommand) => WorkspaceExecution;
  waiters: ThreadWaiterList;
};

/** A thread being waited on has settled, so the waiting tool call can answer. */
export function releaseThreadWaiters(waiters: ThreadWaiterList, state: WorkspaceState) {
  const waiting = waiters.current;
  if (!waiting.length) return;
  let pending: ThreadWaiter[] | null = null;
  for (let index = 0; index < waiting.length; index += 1) {
    const waiter = waiting[index]!;
    if (waiter.pending(state)) {
      pending?.push(waiter);
    } else {
      pending ??= waiting.slice(0, index);
      clearTimeout(waiter.timer);
      waiter.settle(state);
    }
  }
  if (pending) waiters.current = pending;
}

/**
 * Reads come from the runtime projection, and writes use the shared command execution path.
 */
export async function answerThreadRequest(host: ThreadRequestHost, request: ThreadRequest, prepared?: PreparedThreadRequest | void): Promise<ThreadResponse> {
  const requestId = request.requestId;
  const ok = (result: unknown): ThreadResponse => ({ type: "thread.response", requestId, ok: true, result });
  const failed = (message: string): ThreadResponse => ({ type: "thread.response", requestId, ok: false, message });
  try {
    if (request.op === "list") {
      const { type: _type, op: _op, taskId, requestId: _requestId, ...query } = request;
      return ok(await listAcrossComputers(host, taskId, query, prepared?.stored));
    }
    if (request.op === "read") {
      return ok(await readAcrossComputers(host, request.threadId, request.limit, request.computer));
    }
    if (request.op === "wait") {
      const match = resolveThreadRead(host.state(), request.threadId);
      const threadId = match.thread.id;
      if (!match.computer) {
        const { state, timedOut } = await waitFor(host, (state) => isWorking(state, threadId), request.timeoutMs);
        return ok(threadWaitResult(state, threadId, timedOut));
      }
      /** A paired computer's thread is watched in the state it keeps publishing, which settles it here as it settles there. */
      const computerId = match.computer.id;
      online(match.computer, "waited on");
      const holder = (state: WorkspaceState) => state.computers.paired.find((computer) => computer.id === computerId);
      const { state, timedOut } = await waitFor(host, (state) => {
        const computer = holder(state);
        return computer?.status === "connected" && Boolean(computer.state && isWorking(computer.state, threadId));
      }, request.timeoutMs);
      const computer = holder(state);
      if (!computer) return failed("That computer is no longer paired.");
      online(computer, "waited on");
      const waited = computer.state ? threadWaitResult(computer.state, threadId, timedOut) : null;
      if (!waited) return failed(`No thread has the ID ${threadId}.`);
      return ok({ ...waited, thread: { ...waited.thread, computer: tag(computer) } });
    }
    if (request.op === "browser") {
      const state = host.state();
      if (state.browserApproval?.taskId === request.taskId) return ok({ kind: "awaiting-approval", url: state.browserApproval.url });
      /** A run reaches its own thread's dock, whichever dock the user has on screen. */
      const dock = dockFor(state, dockOwner(state, request.taskId));
      if (request.read.op === "tabs") return ok({ kind: "tabs", tabs: dock.browserTabs });
      const tab = browserTarget(dock, request.read.tabId);
      if (!tab) return ok({ kind: "no-tab" });
      await host.desktop.configureBrowserPermissions(browserPermissions(host.state()));
      if (request.read.op === "screenshot") {
        const shot = await host.desktop.captureBrowserPage(tab.id, request.read.fullPage === true, request.read.timeoutMs, request.taskId);
        return shot ? ok({ kind: "shot", shot }) : ok({ kind: "no-tab" });
      }
      if (request.read.op === "console" || request.read.op === "network" || request.read.op === "wait") {
        const { tabId: _tabId, ...inspection } = request.read;
        const inspected = await host.desktop.inspectBrowserPage(tab.id, inspection, request.taskId);
        return inspected ? ok(inspected) : ok({ kind: "no-tab" });
      }
      const snapshot = await host.desktop.readBrowserPage(tab.id, request.read.textLimit ?? DEFAULT_PAGE_TEXT, request.read.timeoutMs, request.taskId);
      return snapshot ? ok({ kind: "snapshot", snapshot }) : ok({ kind: "no-tab" });
    }
    if (request.op === "terminal") {
      const state = host.state();
      const dock = dockFor(state, dockOwner(state, request.taskId));
      if (request.read.op === "terminals") return ok({ kind: "terminals", terminals: dock.terminals });
      const terminal = terminalTarget(dock, request.read.terminalId, request.taskId);
      if (!terminal) return ok({ kind: "no-terminal" });
      const text = await host.desktop.readTerminal(terminal.id, {
        lines: terminalLineLimit(request.read.lines),
        ...(request.read.match ? { match: request.read.match } : {}),
      });
      if (!text) return ok({ kind: "no-terminal" });
      const { taskId: _thread, id: _id, ...record } = terminal;
      return ok({ kind: "snapshot", snapshot: { terminalId: terminal.id, ...record, ...text } });
    }
    if (request.op === "notify") return ok(await raiseFinding(host, request.taskId, request.report));
    if (request.op === "nothing-to-report") return ok(await reportNothing(host, request.taskId, request.checked));
    if (request.op === "report") return ok(await reportToCoordinator(host, request.taskId, request.state, request.summary));
    if (request.op === "decision") return ok(await raiseDecision(host, request.taskId, request.request));
    const { command } = request;
    const before = host.state();
    /** A browser command acts on a tab rather than a thread, so it answers with the panel's own error. */
    if (command.type.startsWith("browser.")) {
      const result = await host.execute(command).completed;
      return result.ok ? ok({ thread: null }) : failed(result.message);
    }
    if (command.type === "worktree.delete") {
      const root = before.worktrees.find((worktree) => worktree.id === command.worktreeId)?.root;
      if (root && before.deletingWorktrees.includes(root)) return failed("That worktree is already being deleted.");
      const result = await host.execute(command).completed;
      if (!result.ok) return failed(result.message);
      const notice = host.state().worktreeManagementNotice;
      return ok({ thread: null, ...(notice ? { notice } : {}) });
    }
    /** A thread is named the way the tools name it, and found on this computer or a paired one. */
    const target = command.taskId === undefined ? null : resolveThreadRead(before, command.taskId);
    const caller = before.threads.find((thread) => thread.id === request.taskId);
    if (command.type === "task.send" && command.taskId === undefined && !caller) {
      return failed(`No thread has the ID ${request.taskId}.`);
    }
    const named = target ? { ...command, taskId: target.thread.id } as typeof command : command;
    const selected: { command: typeof command } | { error: string } = named.type === "task.send" && named.taskId === undefined && caller
      ? (() => {
          const model = named.model ?? caller.model ?? defaultModelFor(caller.engine);
          if (isCoordinator(caller) && !modelDelegable(model)) return { error: `A coordinator cannot start a thread on the ${model} model. Pick another model.` };
          if (named.effort && !modelHasEffort(model, named.effort)) return { error: `The ${model} model does not support ${named.effort} effort.` };
          /** An inherited effort the new model does not take drops to the nearest one it does. */
          const effort = named.effort ?? effortForModel(model, caller.effort ?? defaultEffortFor(engineForModel(model)));
          const { effort: _asked, ...rest } = named;
          return { command: modelTakesEffort(model) ? { ...named, model, effort } : { ...rest, model } };
        })()
      : { command: named };
    if ("error" in selected) return failed(selected.error);
    /** A coordinator's new thread works under it and starts from the brief it was handed; one its threads start joins them under it. */
    const starting = selected.command.type === "task.send" && selected.command.taskId === undefined;
    const coordinating = starting && isCoordinator(caller);
    if (coordinating && selected.command.type === "task.send" && !selected.command.brief) return failed(BRIEF_REQUIRED);
    const lead = !starting ? undefined : coordinating ? caller : coordinatorOf(before.threads, caller);
    /** A thread on a paired computer, or a new one asked for there, is that computer's to act on. */
    const elsewhere = target ? target.computer : starting && request.computer !== undefined ? namedComputer(before, request.computer) : null;
    if (elsewhere) {
      if (lead) return failed(COORDINATED_HERE);
      return ok(await commandElsewhere(host, elsewhere, selected.command, caller));
    }
    /** A new thread with no place named starts where the thread that asked for it lives: its project, and its worktree when it has one. */
    const callerProjectId = caller?.projectId;
    const placed = selected.command.type === "task.send" && selected.command.taskId === undefined && selected.command.project === undefined && callerProjectId
      ? { ...selected.command, project: callerProjectId }
      : selected.command;
    const targeted = placed.type === "task.send" && placed.taskId === undefined && placed.worktree === undefined && placed.worktreeId === undefined && caller?.worktreeId
      ? { ...placed, worktreeId: caller.worktreeId }
      : placed;
    const led = lead && targeted.type === "task.send" ? { ...targeted, coordinatorId: lead.id } : targeted;
    /** A message one thread sends another names the thread it came from. */
    const signed = led.type === "task.send" && caller && led.taskId !== caller.id ? { ...led, from: caller.id } : led;
    const result = await host.execute(signed).completed;
    if (!result.ok) return failed(result.message);
    const after = host.state();
    const taskId = result.taskId ?? named.taskId;
    const thread = after.threads.find((thread) => thread.id === taskId);
    return ok({ thread: thread ? threadSummary(after, thread) : null });
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/** Holds the call until `pending` stops holding, or until the time runs out. */
function waitFor(host: ThreadRequestHost, pending: (state: WorkspaceState) => boolean, timeoutMs: number): Promise<{ state: WorkspaceState; timedOut: boolean }> {
  if (!pending(host.state())) return Promise.resolve({ state: host.state(), timedOut: false });
  return new Promise((resolve) => {
    const waiter: ThreadWaiter = {
      pending,
      settle: (state) => resolve({ state, timedOut: false }),
      timer: setTimeout(() => {
        host.waiters.current = host.waiters.current.filter((item) => item !== waiter);
        resolve({ state: host.state(), timedOut: true });
      }, timeoutMs),
    };
    host.waiters.current.push(waiter);
  });
}

const COORDINATED_HERE = "A coordinator and the threads under it start threads only on their own computer.";

/** How long a thread just started on a paired computer is given to show up in the state that computer publishes. */
const ARRIVAL_MS = 5_000;

/**
 * A command for a paired computer's thread, or for a new thread there, goes through the reducer,
 * which carries it to that computer. The message says which thread sent it, since that computer
 * may not hold this one's threads, and a new thread starts in the project there that this one's
 * own project matches unless another is named.
 */
async function commandElsewhere(host: ThreadRequestHost, computer: PairedComputer, command: ExternalCommand, caller: Thread | undefined): Promise<ThreadCommandResult> {
  online(computer, "reached");
  if (!computer.state) throw new Error(`${computer.name} has not sent its threads yet. Try again once it is connected.`);
  const state = host.state();
  const sender = caller ? { threadId: caller.id, title: caller.title, computer: state.computers.name || "another computer" } : undefined;
  if (command.type === "task.send" && command.taskId === undefined) {
    const own = state.projects.find((project) => project.id === caller?.projectId);
    const project = projectThere(computer, command.project, own);
    const result = await host.execute({ ...command, project: project.id, ...(sender ? { sender } : {}) }).completed;
    if (!result.ok) throw new Error(result.message);
    const taskId = result.taskId;
    if (taskId === undefined) throw new Error(`${computer.name} did not say which thread it started.`);
    const arrived = await waitFor(host, (state) => !remoteSummary(state, computer.id, taskId), ARRIVAL_MS);
    const thread = remoteSummary(arrived.state, computer.id, taskId);
    return thread ? { thread } : { thread: null, notice: `Started thread ${taskId} on ${computer.name}.` };
  }
  const result = await host.execute(command.type === "task.send" && sender ? { ...command, sender } : command).completed;
  if (!result.ok) throw new Error(result.message);
  return { thread: command.taskId === undefined ? null : remoteSummary(host.state(), computer.id, command.taskId) };
}

/** The project on a paired computer a new thread starts in: the one named, else the one at this thread's project's path or with its folder's name. */
function projectThere(computer: PairedComputer, named: string | undefined, own: Project | undefined): Project {
  const projects = computer.state?.projects ?? [];
  if (named !== undefined) {
    const found = findProject(projects, named);
    if ("error" in found) throw new Error(`On ${computer.name}: ${found.error}`);
    return found.project;
  }
  if (!own) throw new Error(`Name the project on ${computer.name} to start the thread in.`);
  const atRoot = matchingProjects(projects, own.root);
  const matches = atRoot.length ? atRoot : matchingProjects(projects, folderName(own.root));
  if (matches.length === 1) return matches[0]!;
  throw new Error(`${matches.length ? "More than one" : "No"} project on ${computer.name} matches ${projectName(own)}. Name the project to start the thread in.`);
}

/** What the tools say when the caller is not a scheduled run at all. Nothing is written for one. */
const UNSCHEDULED = "This turn is not a scheduled run, so there is nothing to surface or to silence and nothing was recorded. Say what you found in your reply instead; these two tools are only for a run the automation's schedule started.";

function unreadCount(host: ThreadRequestHost, threadId: string) {
  const thread = host.state().threads.find((item) => item.id === threadId);
  return thread ? unreadFindings(thread).length : 0;
}

/** The newest finding a thread carries, named so two reads of it can be compared. */
function newestFindingId(state: WorkspaceState, threadId: string) {
  return state.threads.find((thread) => thread.id === threadId)?.findings?.at(-1)?.id;
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
async function raiseFinding(host: ThreadRequestHost, threadId: string, report: FindingReport): Promise<FindingResult> {
  const before = host.state();
  const thread = before.threads.find((item) => item.id === threadId);
  if (!thread || !scheduledRun(before, threadId)) return { recorded: false, note: UNSCHEDULED };
  const known = !isNews(thread, report.key);
  const newestBefore = newestFindingId(before, threadId);
  await host.dispatch({ type: "automation.notify", taskId: threadId, ...report });
  if (newestFindingId(host.state(), threadId) === newestBefore) {
    if (known) return { recorded: false, note: `This thread already carries a finding keyed "${report.key}", so the same one was held back. Raising only what it already knows lets this run settle unseen.` };
    return { recorded: false, note: TAKEN_OVER };
  }
  const unread = unreadCount(host, threadId);
  const carried = unread === 0
    ? "The user is looking at this thread, so it is already seen"
    : `This thread now carries ${unread} unread ${unread === 1 ? "finding" : "findings"}`;
  return { recorded: true, note: `Raised. ${carried}, and the run surfaces when it settles.` };
}

/** A run saying it looked and found nothing: it answers for the tick without raising anything, which is what leaves a quiet one its silence. */
async function reportNothing(host: ThreadRequestHost, threadId: string, checked: string): Promise<FindingResult> {
  const active = scheduledRun(host.state(), threadId);
  if (!active) return { recorded: false, note: UNSCHEDULED };
  await host.dispatch({ type: "automation.nothing-to-report", taskId: threadId, checked });
  if (active.notified) return { recorded: false, note: "This run already raised something new, so it surfaces anyway and what it found stands." };
  if (!active.quiet) return { recorded: true, note: "Noted. This automation has no quiet sentence, so every run of it surfaces, this one included." };
  return { recorded: true, note: "Noted. This run settles without reaching the user." };
}

const BRIEF_REQUIRED = "A coordinator hands every thread it starts a brief: pass intent (the user's own words), doneWhen, and delivers.";

const NO_COORDINATOR = "This thread works under no coordinator, so there is no one to report to and nothing was recorded. Say it in your reply instead.";

/** A thread under a coordinator saying where its work stands. Its coordinator hears it when this turn ends. */
async function reportToCoordinator(host: ThreadRequestHost, threadId: string, state: CoordinationState, summary: string): Promise<FindingResult> {
  const thread = host.state().threads.find((item) => item.id === threadId);
  if (!coordinatorOf(host.state().threads, thread)) return { recorded: false, note: NO_COORDINATOR };
  await host.dispatch({ type: "coordination.reported", taskId: threadId, state, summary });
  if (state === "working") return { recorded: true, note: "Noted. Progress is not passed on; report again when you are blocked, done, or failed." };
  return { recorded: true, note: "Reported. Your coordinator hears it when this turn ends." };
}

/** Puts a choice to the user. Only a coordinator and the threads under it have somewhere to show one. */
async function raiseDecision(host: ThreadRequestHost, threadId: string, request: DecisionRequest): Promise<FindingResult> {
  const threads = host.state().threads;
  const thread = threads.find((item) => item.id === threadId);
  if (!isCoordinator(thread) && !coordinatorOf(threads, thread)) {
    return { recorded: false, note: "Only a coordinator and the threads working under it can raise decisions, so nothing was recorded. Ask the user in your reply instead." };
  }
  await host.dispatch({ type: "coordination.decision-raised", taskId: threadId, request });
  return { recorded: true, note: "Raised. The user sees it now, and their answer arrives in this thread as a message. If you cannot go on without it, end your turn." };
}
