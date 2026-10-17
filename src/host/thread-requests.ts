import { browserPermissions } from "../application/workspace-reducer.js";
import { browserTarget, dockFor, dockOwner, terminalTarget, type WorkspaceState } from "../application/workspace-state.js";
import { threadSummary, threadWaitResult } from "../application/thread-projection.js";
import { isWorking } from "../application/thread-activity.js";
import { listAcrossComputers, namedComputer, online, readAcrossComputers, remoteSummary, resolveThreadRead, tag, type PreparedThreadRequest } from "./thread-reads.js";
import { projectOnComputer, type PairedComputer } from "../application/computers.js";
import { newThreadSend, threadProposal, type NewThreadSend } from "../application/thread-starts.js";
import { clampTitle, type Thread } from "../domain/thread.js";
import type { WorktreeDestination } from "../domain/worktree.js";
import { projectFor, worktreeById, worktreeFor } from "../application/thread-location.js";
import { isNews, unreadFindings } from "../domain/attention.js";
import { scheduledRun } from "../application/run-testimony.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { AppCommand } from "../contracts/commands.js";
import type { ExternalCommand, FindingReport, FindingResult, ThreadCommandResult, ThreadRequest, ThreadResponse, ThreadTranscript } from "../contracts/threads.js";
import { REMOTE_UNSUPPORTED } from "../contracts/computer-capabilities.js";
import { terminalLineLimit } from "../domain/terminal.js";
import { coordinatorOf, isCoordinator, MAX_PROPOSALS, withMemoryChange, worksUnderCoordinator, type CoordinationState, type DecisionRequest, type MemoryChange, type ProposalRequest, type ThreadProposal } from "../domain/coordination.js";
import { errorMessage } from "./errors.js";
import type { RuntimeDesktop } from "./runtime-desktop.js";

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
      /** A thread whose history that computer has not loaded is mirrored without its messages, so its reply is read from there. */
      const unloaded = Boolean(computer.state?.threads.find((thread) => thread.id === threadId)?.historySummary);
      const reply = waited.reply === null && unloaded ? lastReply(await readAcrossComputers(host, threadId, MAX_REMOTE_MESSAGES, computerId)) : waited.reply;
      return ok({ ...waited, reply, thread: { ...waited.thread, computer: tag(computer) } });
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
    if (request.op === "memory") return ok(await rememberFor(host, request.taskId, request.change));
    if (request.op === "propose") return ok(await proposeThreads(host, request.taskId, request.proposals));
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
    if ((command.type === "task.send" || command.type === "task.move-worktree") && command.taskId === undefined && !caller) {
      return failed(`No thread has the ID ${request.taskId}.`);
    }
    /** A thread moving itself is mid-run, so it goes once that run ends; a move naming no thread is the caller's. */
    const ownMove = command.type === "task.move-worktree" && caller && (command.taskId === undefined || target?.thread.id === caller.id && !target.computer)
      ? { ...command, taskId: caller.id, afterRun: true as const }
      : undefined;
    const named = ownMove ?? (target ? { ...command, taskId: target.thread.id } as typeof command : command);
    /** A new thread starts by the rules every start shares; a command for an existing thread goes where that thread is. */
    const start = named.type === "task.send" && named.taskId === undefined && caller
      ? newThreadSend(before, caller, named, request.computer === undefined ? undefined : namedComputer(before, request.computer))
      : null;
    if (start && "error" in start) return failed(start.error);
    if (start?.elsewhere) {
      if (start.lead) return ok(await proposeElsewhere(host, caller!, start.lead, start.elsewhere, named as NewThreadSend));
      return ok(await commandElsewhere(host, start.elsewhere, start.command, caller));
    }
    if (target?.computer) return ok(await commandElsewhere(host, target.computer, named, caller));
    /** A message one thread sends another names the thread it came from. */
    const signed = start ? start.command : named.type === "task.send" && caller && named.taskId !== caller.id ? { ...named, from: caller.id } : named;
    const result = await host.execute(signed).completed;
    if (!result.ok) return failed(result.message);
    const after = host.state();
    const taskId = result.taskId ?? named.taskId;
    const thread = after.threads.find((thread) => thread.id === taskId);
    const waiting = ownMove && thread && after.movesAfterRun[thread.id];
    const notice = waiting ? movesAfterTurn(after, thread, waiting) : undefined;
    return ok({ thread: thread ? threadSummary(after, thread) : null, ...(notice ? { notice } : {}) });
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/** What a thread moving itself is told: where it is until this turn ends, and where its next turn starts. */
function movesAfterTurn(state: WorkspaceState, thread: Thread, destination: WorktreeDestination) {
  const project = projectFor(state, thread)?.root;
  const there = destination.kind === "worktree" ? worktreeById(state, destination.id)?.root : destination.kind === "new" ? "a new worktree" : project;
  const here = worktreeFor(state, thread)?.root ?? project;
  return `This thread moves to ${there} when this turn ends, and its next turn starts there. Until then it stays in ${here}, and file changes already made there stay behind.`;
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

/** As many messages as a paired computer hands over in one read. */
const MAX_REMOTE_MESSAGES = 200;

function lastReply(transcript: ThreadTranscript): string | null {
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    if (transcript.messages[index]!.kind === "assistant") return transcript.messages[index]!.text;
  }
  return null;
}

const SIGNED_SEND = "command:task.send:sender";

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
  /** A build from before capabilities were told names none and would take the message as the user's, so a signed one needs the capability named. */
  if (command.type === "task.send" && sender && !computer.capabilities?.includes(SIGNED_SEND)) throw new Error(REMOTE_UNSUPPORTED);
  if (command.type === "task.send" && command.taskId === undefined) {
    const own = state.projects.find((project) => project.id === caller?.projectId);
    const found = projectOnComputer(computer, command.project, own);
    if ("error" in found) throw new Error(found.error);
    const { project } = found;
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

/**
 * A thread a coordinator, or one of the threads under it, asks to start on a paired computer. Nothing
 * starts there until the user allows it: the request is checked as its start would be, placed in the
 * project there it would start in, and waits beside the coordinator's suggestions for the user.
 */
async function proposeElsewhere(host: ThreadRequestHost, caller: Thread, lead: Thread, computer: PairedComputer, command: NewThreadSend): Promise<ThreadCommandResult> {
  const { type: _type, text, taskId: _new, attachments: _attachments, steer: _steer, ...asked } = command;
  const prompt = text ?? "";
  const made = threadProposal(host.state(), caller, { ...asked, title: clampTitle(prompt), prompt }, Date.now(), computer);
  if ("error" in made) throw new Error(made.error);
  const kept = await fileProposals(host, lead.id, [made.proposal]);
  if (!kept.has(made.proposal.id)) throw new Error(PROPOSALS_FULL);
  const folder = computer.state?.projects.find((project) => project.id === made.proposal.place.project)?.root ?? "its project";
  const news = caller.id === lead.id ? "You hear once it starts and when it ends a turn." : "Your coordinator hears once it starts.";
  return { thread: null, notice: `Waiting for the user to allow it on ${computer.name} in ${folder}. ${news}` };
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

const NO_COORDINATOR = "This thread works under no coordinator, so there is no one to report to and nothing was recorded. Say it in your reply instead.";

/** A thread under a coordinator saying where its work stands. Its coordinator hears it when this turn ends. */
async function reportToCoordinator(host: ThreadRequestHost, threadId: string, state: CoordinationState, summary: string): Promise<FindingResult> {
  const thread = host.state().threads.find((item) => item.id === threadId);
  if (!worksUnderCoordinator(host.state().threads, thread)) return { recorded: false, note: NO_COORDINATOR };
  await host.dispatch({ type: "coordination.reported", taskId: threadId, state, summary });
  if (state === "working") return { recorded: true, note: "Noted. Progress is not passed on; report again when you are blocked, done, or failed." };
  return { recorded: true, note: "Reported. Your coordinator hears it when this turn ends." };
}

/** Puts a choice to the user. Only a coordinator and the threads under it have somewhere to show one. */
async function raiseDecision(host: ThreadRequestHost, threadId: string, request: DecisionRequest): Promise<FindingResult> {
  const threads = host.state().threads;
  const thread = threads.find((item) => item.id === threadId);
  if (!isCoordinator(thread) && !worksUnderCoordinator(threads, thread)) {
    return { recorded: false, note: "Only a coordinator and the threads working under it can raise decisions, so nothing was recorded. Ask the user in your reply instead." };
  }
  await host.dispatch({ type: "coordination.decision-raised", taskId: threadId, request });
  return { recorded: true, note: "Raised. The user sees it now, and their answer arrives in this thread as a message. If you cannot go on without it, end your turn." };
}

/** What a coordinator and every thread it starts from now on read, said back as the coordinator's tools answer. */
const READ_FROM_NOW = "You and every thread you start from now on read it.";

/**
 * A coordinator changing its own memory. The change is tried against the memory as it stands, so a
 * refusal answers the tool rather than reaching the user; once made, the saved note is read back.
 */
async function rememberFor(host: ThreadRequestHost, threadId: string, change: MemoryChange): Promise<{ note: string }> {
  const thread = host.state().threads.find((item) => item.id === threadId);
  if (!thread || !isCoordinator(thread)) throw new Error("Only a coordinator keeps a memory.");
  const tried = withMemoryChange(thread, change, Date.now(), { heard: true });
  if ("error" in tried) throw new Error(tried.error);
  await host.dispatch({ type: "coordination.remembered", taskId: threadId, change });
  const memory = host.state().threads.find((item) => item.id === threadId)?.memory;
  if (change.kind === "purpose") return { note: memory?.purpose ? `Purpose set. ${READ_FROM_NOW}` : "Purpose cleared." };
  if (change.kind === "forget") return { note: `Forgot [${change.noteId}].` };
  /** The trial named the note the change adds, so a note that matches it only in text is never taken for it. */
  const saved = memory?.notes.find((note) => note.id === tried.noteId);
  if (!saved || saved.text !== change.text.trim()) throw new Error("The note could not be saved. Try again.");
  return { note: `Saved as [${saved.id}]. ${READ_FROM_NOW}` };
}

const PROPOSALS_FULL = `At most ${MAX_PROPOSALS} suggestions wait at once. Wait for the user to start or dismiss some.`;

/** One suggestion checked as its start would be, on the paired computer it names when it names one. */
function checkedProposal(state: WorkspaceState, lead: Thread, request: ProposalRequest, at: number): ReturnType<typeof threadProposal> {
  try {
    return threadProposal(state, lead, request, at, request.computer === undefined ? undefined : namedComputer(state, request.computer));
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * Files suggestions on their coordinator, as many as it has room for, and reads back the ones it
 * kept, since the user may have filled the room meanwhile.
 */
async function fileProposals(host: ThreadRequestHost, leadId: string, proposals: readonly ThreadProposal[]): Promise<Set<string>> {
  if (proposals.length) await host.dispatch({ type: "coordination.proposed", taskId: leadId, proposals: [...proposals] });
  const held = new Set(host.state().threads.find((item) => item.id === leadId)?.proposals?.map((proposal) => proposal.id));
  return new Set(proposals.flatMap((proposal) => held.has(proposal.id) ? [proposal.id] : []));
}

/**
 * A coordinator suggesting threads. Each is checked now as its start would be, so what cannot start
 * comes straight back, item by item, and only what can waits for the user. Nothing starts here.
 */
async function proposeThreads(host: ThreadRequestHost, threadId: string, requests: ProposalRequest[]): Promise<{ note: string }> {
  const state = host.state();
  const lead = state.threads.find((item) => item.id === threadId);
  if (!lead || !isCoordinator(lead)) throw new Error("Only a coordinator suggests threads.");
  const at = Date.now();
  const checked = requests.map((request) => ({ request, made: checkedProposal(state, lead, request, at) }));
  const kept = await fileProposals(host, threadId, checked.flatMap(({ made }) => "error" in made ? [] : [made.proposal]));
  const lines = checked.flatMap(({ request, made }) => {
    if ("error" in made) return [`Not suggested "${request.title}": ${made.error}`];
    return kept.has(made.proposal.id) ? [] : [`Not suggested "${made.proposal.title}": ${PROPOSALS_FULL}`];
  });
  if (!kept.size) throw new Error(lines.join("\n"));
  const said = `Suggested ${kept.size === 1 ? "1 thread" : `${kept.size} threads`}. The user starts the ones they want; you hear from each once it ends a turn.`;
  return { note: [said, ...lines].join("\n") };
}
