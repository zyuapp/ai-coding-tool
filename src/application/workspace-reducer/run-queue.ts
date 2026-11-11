/** Starting a run: the prompt it carries, the checkout it asks for, and the messages waiting behind it. */
import { now } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { promptWithAnnotations } from "../annotations.js";
import { promptWithAttachments } from "../attachments.js";
import { annotationsFor, composerOf, filesFor, handedBackIn, imagesFor, pastesFor, textAfterSend, withAnnotations, withFiles, withImages, withPastes } from "../composer-drafts.js";
import { afterward, applied, type Step } from "./slice.js";
import { attendedIn, cancellingIn, pendingIn, queuedIn, runsOf, stopAskedIn, withoutPendingIn } from "./run-edits.js";
import { answerReopenedIn, notedIn, threadsOf, turnOpenedIn, type ThreadsEdit } from "./thread-edits.js";
import { promptWithFiles } from "../files.js";
import { promptWithPastes } from "../pastes.js";
import { ATTENDED_RUN, openedTurn, threadMark, updateThread, withActiveRun, withRunStatus, type ActiveRun, type RunProvenance, type ThreadMark } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import { runOf, runStatus, threadBusy } from "../run-record.js";
import type { DraftBranch, PendingRun, QueuedMessage, SideChat, WorkspaceState } from "../workspace-state.js";
import { withPrompt } from "../state/composer.js";
import type { StartRunCommand } from "../../contracts/ipc.js";
import { withoutOutcome } from "../../domain/attention.js";
import { coordinationRole } from "../coordination.js";
import { undeliveredNote } from "../coordination-messages.js";
import { GROUP_OF } from "../coordinated-thread-status.js";
import { withTurnBegun } from "../outstanding-stops.js";
import { isCoordinator, withoutReport } from "../../domain/coordination.js";
import { capabilitiesFor, defaultEffortFor, effortForModel, policyFor, threadModel, type AgentModel } from "../../domain/agent-engine.js";
import { catalogOf } from "../state/engines.js";
import { createSentMessage, type Annotation, type AttachedFile, type PastedText, type RunAttachment } from "../../domain/conversation.js";
import type { Project } from "../../domain/project.js";
import { isUsersOwn, legacyOrigin } from "../../domain/message-origin.js";
import { lastRunOutcome, type Thread } from "../../domain/thread.js";
import { withoutLimitPause } from "../../domain/usage-limit.js";
import type { Worktree } from "../../domain/worktree.js";

export function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return afterward(state, pendingStep(state, pending));
}

/** A run on its way, which takes down the error a run before it left. */
export function pendingStep(state: WorkspaceState, pending: PendingRun): Step {
  return { edits: [pendingIn(runsOf(state), pending)], clearsError: true };
}

export function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
}

/**
 * A run dropped before its message reached the thread. A decision that message answers is open
 * again, to be answered anew, as one a queued message answers is when it never goes.
 */
export function withUnsent(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return afterward(state, unsent(state, pending));
}

/** {@link withUnsent}, as the edits it makes. */
export function unsent(state: WorkspaceState, pending: PendingRun): Step {
  const runs = withoutPendingIn(runsOf(state), pending.id);
  const { answers, taskId } = pending;
  return { edits: answers === undefined || taskId === undefined ? [runs] : [runs, answerReopenedIn(threadsOf(state), taskId, answers)] };
}

export function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

export function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  return afterward(state, { edits: [queuedIn(runsOf(state), taskId, messages)] });
}

/** Everything drafted alongside the text, flattened into the one prompt the agent reads. */
export function sentPrompt(text: string, pastes: PastedText[], annotations: Annotation[], attachments: RunAttachment[], files: AttachedFile[]) {
  return promptWithFiles(promptWithAttachments(promptWithAnnotations(promptWithPastes(text, pastes), annotations), attachments), files);
}

/** The parent keeps running after a fork. Give each side-chat send app state, not copied recovery notices. */
export function sideChatPrompt(state: WorkspaceState, taskId: string, prompt: string): string {
  // Native slash commands must reach the provider without extra arguments.
  if (prompt.trimStart().startsWith("/")) return prompt;
  const chat = state.sideChats.find((item) => item.id === taskId);
  if (!chat) return prompt;
  const parent = state.threads.find((item) => item.id === chat.sourceThreadId);
  const workingAgents = (state.subagents[chat.sourceThreadId] ?? []).filter((agent) => agent.status === "working");
  const status = {
    taskId: chat.sourceThreadId,
    capturedAt: now(),
    ...(parent ? {
      title: parent.title,
      status: runOf(state, parent.id)?.status ?? (threadBusy(state, parent.id) ? "running" : runStatus(state, parent.id)),
      lastRunOutcome: lastRunOutcome(parent) ?? null,
      workingAgents: workingAgents.length,
      // Identify the same helpers mentioned in inherited notices without copying their activity logs.
      workingAgentIds: workingAgents.slice(0, 16).map((agent) => agent.id),
    } : { status: "unknown" }),
  };
  return `Context for the side-chat question below (not an assignment):\n<parent-task-status>\n${JSON.stringify(status)}\n</parent-task-status>\nThis is the parent's state from the app when the question was sent. The helpers listed as working are running in the parent. The fork cannot resume those processes: any copied process-exited or lost-state notice describes that limitation of the fork, not a failure of the parent or its helpers. This status supplies no findings or failure cause; do not infer either from those notices.\n\n${prompt}`;
}

/** A composer whose send has started: what it carried goes, and whatever was typed or added since stays. */
export function withoutStartedDraft(state: WorkspaceState, draftKey: string, pending: PendingRun): WorkspaceState {
  const typed = state.prompts[draftKey] ?? "";
  const prompted = withPrompt(state, draftKey, textAfterSend(typed, pending.draftText ?? typed));
  const annotated = withAnnotations(prompted, draftKey, annotationsFor(state, draftKey).filter((annotation) => !pending.annotations?.some((sent) => sent.id === annotation.id && sent.note === annotation.note)));
  const pasted = withPastes(annotated, draftKey, pastesFor(state, draftKey).filter((paste) => !pending.pastes?.some((sent) => sent.id === paste.id)));
  const imaged = withImages(pasted, draftKey, imagesFor(state, draftKey).filter((image) => !pending.attachments.includes(image.path)));
  return withFiles(imaged, draftKey, filesFor(state, draftKey).filter((file) => !pending.files?.some((sent) => sent.path === file.path)));
}

/** The model a run on this thread goes to, for a thread its start has already found one for. */
export function runModelOf(state: WorkspaceState, thread: Thread): AgentModel {
  const model = threadModel(catalogOf(state), thread);
  if (model === undefined) throw new Error(`No model to run the thread ${thread.id} on.`);
  return model;
}

export function startRunCommand(state: WorkspaceState, thread: Thread, runId: string, prompt: string, workspaceId: string, policy = thread.executionPolicy): StartRunCommand {
  const model = runModelOf(state, thread);
  const coordination = coordinationRole(state.threads, thread);
  /** A member running anywhere but its project's checkout is told that checkout, which stays the user's. */
  const project = coordination === "member" ? projectFor(state, thread) : undefined;
  const userCheckout = project?.workspaceId && project.workspaceId !== workspaceId ? { projectWorkspaceId: project.workspaceId } : {};
  return {
    type: "start",
    channel: "main",
    taskId: thread.id,
    title: thread.title,
    runId,
    prompt: sideChatPrompt(state, thread.id, prompt),
    workspaceId,
    policy: policyFor(thread.engine, policy),
    engine: thread.engine,
    model,
    effort: effortForModel(catalogOf(state), thread.engine, model, thread.effort ?? defaultEffortFor(thread.engine), coordination),
    ...(capabilitiesFor(thread.engine).fastMode ? { fastMode: thread.fastMode ?? false } : {}),
    ...(state.chromeBrowser && capabilitiesFor(thread.engine).chromeBrowser ? { chromeBrowser: true as const } : {}),
    ...(state.computerUse ? {} : { computerUseTools: false as const }), ...(state.browserTools ? {} : { browserTools: false as const }),
    ...(state.simulator.availability.status === "available" ? {} : { simulatorTools: false as const }),
    ...(thread.continuation ? { continuation: thread.continuation } : {}),
    ...(thread.continuation && thread.inheritedContinuation ? { forkContinuation: true as const } : {}),
    ...(coordination ? { coordinationRole: coordination } : {}),
    ...userCheckout,
  };
}

/**
 * Mirrors archiving or restoring into the engine's own record of the thread. A copy that has yet to
 * run still names its source's session, which is not its to file away; archiving one mid-run, or a
 * thread whose first run has yet to name a session, leaves the engine to file the session it holds.
 */
export function fileThread(state: WorkspaceState, thread: Thread | undefined, archived: boolean): WorkspaceEffect[] {
  if (!thread) return [];
  const continuation = thread.inheritedContinuation ? undefined : thread.continuation;
  if (!continuation && !(archived && state.activeRuns[thread.id])) return [];
  const channel = sideChannelFor(state, thread).channel ?? "main";
  return [{ type: "send-run-command", command: { type: "archive", taskId: thread.id, channel, ...(continuation ? { continuation } : {}), archived } }];
}

/** A side chat's first turn forks the source thread; every turn after resumes its own branch. */
export function sideChannelFor(state: WorkspaceState, thread: Thread): Partial<StartRunCommand> {
  if (!state.sideChats.some((chat) => chat.id === thread.id)) return {};
  if (thread.continuation) return { channel: "side" };
  const continuation = forkableContinuation(state, thread.id);
  return continuation ? { channel: "side", continuation, forkContinuation: true } : { channel: "side" };
}

/** The continuation a side chat starts from: its own once it has one, the source thread's before that. */
export function forkableContinuation(state: WorkspaceState, taskId: string) {
  const chat = state.sideChats.find((item) => item.id === taskId);
  if (!chat) return undefined;
  const thread = state.threads.find((item) => item.id === taskId);
  return thread?.continuation ?? state.threads.find((item) => item.id === chat.sourceThreadId)?.continuation;
}

/**
 * How a run picks a thread up when nobody has written to it: `warming` resumes it after its usage
 * limit lifted, `carrying-on` resumes the turn an update's restart cut off, and `agent` is a turn the
 * agent opened itself.
 */
type RunPickup = "warming" | "carrying-on" | "agent";

/**
 * Records the run against the thread and marks it the thread's latest, so stale replies can be dropped.
 * The new run supersedes whatever the last one concluded, so how it ended, its verdict and the report
 * it made never outlive it, and it keeps where the thread stood, which is what a run that settles
 * unseen puts back.
 */
export function beginRun(state: WorkspaceState, taskId: string, runId: string, provenance: RunProvenance = ATTENDED_RUN, before?: ThreadMark, pickup?: RunPickup): WorkspaceState {
  /** A run that starts is the thread picked back up, whatever its place in line. */
  const threads = withoutOutcome(state.threads, new Set([taskId])).map((thread) => thread.id === taskId ? openedTurn(pickedUp(thread, pickup), provenance) : thread);
  const messagesBefore = threads.find((thread) => thread.id === taskId)?.messages.length ?? 0;
  const mark = before ?? threadMark(state.threads.find((thread) => thread.id === taskId));
  /** The turn the agent opens itself to answer what Stop all stopped ends quietly too. */
  const begun = withTurnBegun(state, taskId, pickup === "agent", now());
  const answering = begun.answersStop ? { answersStop: true as const } : {};
  const own = pickup === "agent" ? { agentInitiated: true as const } : {};
  return withRunStatus(
    withActiveRun({ ...begun.state, threads, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running", ...provenance, notified: false, acknowledged: false, reportedIssues: [], messagesBefore, before: mark, ...(pickup === "warming" ? { warming: true as const } : {}), ...own, ...answering }),
    taskId,
    "running",
  );
}

function pickedUp(thread: Thread, pickup: RunPickup | undefined): Thread {
  const { runEndedAs: _superseded, ...rest } = thread;
  return withoutLimitPause(reportStands(thread, pickup) ? rest : withoutReport(rest));
}

/**
 * A run resuming after a usage limit or an update carries on the turn that was cut short, so what that
 * turn reported still stands. A turn the agent opened itself was answered by nobody, so a report that the
 * thread needs the user stands through it until the user writes or the agent reports again.
 */
function reportStands(thread: Thread, pickup: RunPickup | undefined) {
  return pickup === "warming" || pickup === "carrying-on" || pickup === "agent" && thread.report !== undefined && GROUP_OF[thread.report.state] === "needs";
}

/**
 * A human who joins a scheduled run owns it from then on: what it finds is an answer to them, and the
 * app quitting under it cuts their turn off. A quiet run starts its turn there; one already open has.
 */
export function withAttendedRun(state: WorkspaceState, taskId: string): WorkspaceState {
  return afterward(state, attendedRun(state, taskId));
}

/** {@link withAttendedRun}, as the edits it makes. */
export function attendedRun(state: WorkspaceState, taskId: string): Step {
  const active = state.activeRuns[taskId];
  if (!active || active.origin === "composer") return {};
  return { edits: [attendedIn(runsOf(state), taskId), turnOpenedIn(threadsOf(state), taskId, { ...active, origin: "composer" })] };
}

/**
 * A steered message joined the run, so it leaves the queue and takes its place in the thread. One
 * that is not the user's own makes a turn they started no longer only theirs.
 */
export function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  const active = state.activeRuns[taskId];
  /** Only a message marked the user's own as it was sent keeps their turn theirs: a thread's steer into itself carries no origin, and is not. */
  const joined = active?.usersOwn && !delivered.usersOwn ? withActiveRun(state, taskId, withoutUsersOwn(active)) : state;
  return updateThread(withAttendedRun(withQueued(joined, taskId, queued.filter((message) => message.id !== messageId)), taskId), taskId, (thread) => ({
    ...thread,
    messages: [...thread.messages, createSentMessage(delivered)],
    updatedAt: now(),
  }));
}

function withoutUsersOwn({ usersOwn: _joined, ...run }: ActiveRun): ActiveRun {
  return run;
}

/** A rejected steer stays queued, with its controls restored and the error on its own surface. */
export function withSteeringFailure(state: WorkspaceState, taskId: string, messageId: string, error: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  if (!queued.some((message) => message.id === messageId && message.steering)) return state;
  const next = withQueued(state, taskId, queued.map((message) => message.id === messageId ? { ...message, steering: false } : message));
  return next.sideChats.some((chat) => chat.id === taskId)
    ? withSideChat(next, taskId, (chat) => ({ ...chat, error }))
    : { ...next, actionError: error, actionErrorPage: null };
}

/**
 * The user stopping a thread's run. The run remembers it was asked, so however it ends first, it ends
 * as the stop asked.
 */
export function cancelling(state: WorkspaceState, active: ActiveRun): Step {
  return { edits: [cancellingIn(runsOf(state), active.taskId)], effects: [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }] };
}

/** The kill is the agent process's to make; the row only says a stop is on its way. */
export function stoppingProcess(state: WorkspaceState, taskId: string, processId: string): WorkspaceTransition {
  return applied(state, processStopped(state, taskId, processId));
}

/** {@link stoppingProcess}, as the edits it makes. A workflow or a subagent is a task of the agent process like any other, so the same stop reaches it. */
export function processStopped(state: WorkspaceState, taskId: string, processId: string): Step {
  const marked = stopAskedIn(runsOf(state), taskId, processId);
  return marked ? { edits: [marked], effects: [{ type: "send-run-command", command: { type: "stop-process", taskId, processId } }] } : {};
}

/**
 * The queued message the user may take back into the composer to rewrite, or why not: a steered one
 * is already on its way to the agent, and only the user's own messages are theirs to rewrite.
 */
/** Whether a queued message is already on its way into a run that is starting, which takes it out of the queue once it does. */
export function drainingQueued(state: Pick<WorkspaceState, "pendingRuns">, taskId: string, messageId: string): boolean {
  return Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId && pending.queuedIds?.includes(messageId));
}

/**
 * Queued messages put back in the thread's composer, ahead of whatever is drafted there, with
 * everything they carry. The caller has already taken them out of the queue.
 */
export function handedBack(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  return afterward(state, { edits: [handedBackIn(composerOf(state), taskId, messages)] });
}

/**
 * Queued messages that will never reach the thread. A decision one answers is open again, to be
 * answered anew, and a coordinator here that sent one hears it was not delivered. The caller has
 * already taken them out of the queue.
 */
export function withUndelivered(state: WorkspaceState, taskId: string, messages: readonly QueuedMessage[]): WorkspaceState {
  return afterward(state, { edits: [undeliveredIn(threadsOf(state), taskId, messages)] });
}

/** {@link withUndelivered}, on the threads an input is changing. */
export function undeliveredIn(edit: ThreadsEdit, taskId: string, messages: readonly QueuedMessage[]): ThreadsEdit {
  const recipient = edit.view.threads.find((thread) => thread.id === taskId);
  if (!recipient) return edit;
  let next = edit;
  for (const { answers, origin, text } of messages) {
    if (answers !== undefined) next = answerReopenedIn(next, taskId, answers);
    const sender = origin?.kind === "thread" && origin.computer === undefined ? next.view.threads.find((thread) => thread.id === origin.threadId) : undefined;
    if (sender && isCoordinator(sender)) next = notedIn(next, sender.id, undeliveredNote(recipient, text, now()));
  }
  return next;
}

/**
 * What becomes of a thread's queue: its next message goes, goes as the run that takes the thread
 * out of its usage limit's line and warms up before the next thread in line goes, or what the user
 * wrote is handed back to the composer.
 */
export type QueueIntent = "deliver" | "resume" | "hand-back";

/**
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped, or whose thread they
 * archived, hands what they wrote back to the composer instead of speaking for them, and nothing
 * else queued is delivered.
 */
export function drained(state: WorkspaceState, taskId: string, intent: QueueIntent): Step {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return {};
  const thread = state.threads.find((item) => item.id === taskId);
  if (intent === "hand-back" || thread?.archivedAt !== undefined) {
    const own = queued.filter(isUsersOwn);
    const undelivered = undeliveredIn(threadsOf(state), taskId, queued.filter((message) => !isUsersOwn(message)));
    return { edits: [queuedIn(runsOf(state), taskId, []), undelivered, ...own.length ? [handedBackIn(composerOf(state), taskId, own)] : []] };
  }
  if (!thread) return { edits: [queuedIn(runsOf(state), taskId, [])] };
  /** A thread waiting out its usage limit keeps its queue until the limit lifts. */
  if (thread.limitPause) return {};
  /** A thread moving into a checkout still being made keeps its queue until it lands there. */
  if (state.creatingWorktrees.includes(taskId)) return {};
  const [next] = queued;
  /** A message from a build that kept only a label says where it came from by that label. */
  const origin = next.origin ?? (next.detail ? legacyOrigin(next.detail) : undefined);
  const project = projectFor(state, thread);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    taskId,
    ...(project ? { projectId: project.id } : {}),
    text: next.text,
    prompt: next.prompt,
    attachments: next.attachments,
    ...(next.annotations ? { annotations: next.annotations } : {}),
    ...(next.pastes ? { pastes: next.pastes } : {}),
    ...(next.files ? { files: next.files } : {}),
    ...(origin ? { messageOrigin: origin } : {}),
    ...(next.answers ? { answers: next.answers } : {}),
    ...(next.usersOwn ? { usersOwn: true as const } : {}),
    queuedIds: [next.id],
    ...(intent === "resume" ? { warming: true as const } : {}),
  };
  return { ...pendingStep(state, pending), effects: [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(state, thread), false)] };
}

/**
 * Where a run happens: the checkout the thread is already in or was started in, one made on the way
 * if the thread asked for a new one, and otherwise the project itself. A thread that is moving takes
 * its uncommitted work with it; a thread starting in a worktree begins from that checkout as it
 * stands, which is also why a branch to start from has nothing left to say once one is named.
 */
export function resolveWorkspaceEffect(pendingId: string, thread: Thread | undefined, project: Project | undefined, worktree: Worktree | undefined, wantsWorktree: boolean, branch?: DraftBranch | null): Extract<WorkspaceEffect, { type: "resolve-run-workspace" }> {
  if (worktree) {
    return { type: "resolve-run-workspace", pendingId, picker: false, workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root } };
  }
  /** A branch the user named but the repository does not have yet is made before either path reads it. */
  const making = branch?.create && project?.workspaceId
    ? { createBranch: { workspaceId: project.workspaceId, branch: branch.name } }
    : {};
  if (wantsWorktree && project?.workspaceId) {
    return {
      type: "resolve-run-workspace",
      pendingId,
      picker: false,
      root: project.root,
      ...making,
      createWorktree: { projectRoot: project.root, carryChanges: Boolean(thread), ...(branch ? { branch: branch.name } : {}) },
    };
  }
  return {
    type: "resolve-run-workspace",
    pendingId,
    picker: Boolean(project && !project.workspaceId),
    ...(project?.workspaceId ? { workspace: { id: project.workspaceId, kind: "project" as const, root: project.root } } : {}),
    ...(project ? { root: project.root } : {}),
    ...making,
    /** Without a checkout of its own, starting from a branch means moving the project onto it. */
    ...(branch && project?.workspaceId ? { checkout: { workspaceId: project.workspaceId, branch: branch.name } } : {}),
  };
}

export function withSideChat(state: WorkspaceState, chatId: string, update: (chat: SideChat) => SideChat): WorkspaceState {
  return { ...state, sideChats: state.sideChats.map((chat) => chat.id === chatId ? update(chat) : chat) };
}
