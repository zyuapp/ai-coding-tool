/** Starting a run: the prompt it carries, the checkout it asks for, and the messages waiting behind it. */
import { now, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { promptWithAnnotations } from "../annotations.js";
import { promptWithAttachments } from "../attachments.js";
import { annotationsFor, composerDraft, filesFor, imagesFor, pastesFor, withAnnotations, withFiles, withImages, withPastes } from "../composer-drafts.js";
import { promptWithFiles } from "../files.js";
import { promptWithPastes } from "../pastes.js";
import { ATTENDED_RUN, runStatusFor, threadMark, updateThread, withActiveRun, withBackgroundProcesses, withRunStatus, withSubagents, withWorkflows, type ActiveRun, type RunProvenance, type ThreadMark } from "../thread-run-state.js";
import { projectFor, threadWorkspaceId, worktreeFor } from "../thread-location.js";
import { withPrompt, type DraftBranch, type PendingRun, type QueuedMessage, type SideChat, type WorkspaceState } from "../workspace-state.js";
import type { ClaudeRunSettings, StartRunCommand } from "../../contracts/ipc.js";
import { withoutOutcome } from "../../domain/attention.js";
import { coordinationRole, GROUP_OF, undeliveredNote, type QuietSession } from "../coordination.js";
import { isCoordinator, withCoordinationNote, withoutAnswer, withoutReport } from "../../domain/coordination.js";
import { capabilitiesFor, defaultEffortFor, defaultModelFor, effortForModel } from "../../domain/agent-engine.js";
import type { RunStatus } from "../../domain/run.js";
import { createSentMessage, type Annotation, type AttachedFile, type PastedText, type RunAttachment } from "../../domain/conversation.js";
import type { Project } from "../../domain/project.js";
import { isUsersOwn } from "../../domain/message-origin.js";
import { lastRunOutcome, type Thread } from "../../domain/thread.js";
import { withoutLimitPause } from "../../domain/usage-limit.js";
import type { Worktree } from "../../domain/worktree.js";

export function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
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
  const without = withoutPending(state, pending.id);
  const { answers, taskId } = pending;
  return answers === undefined || taskId === undefined ? without : updateThread(without, taskId, (thread) => withoutAnswer(thread, answers));
}

export function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

export function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  if (messages.length) return { ...state, queuedMessages: { ...state.queuedMessages, [taskId]: messages } };
  const { [taskId]: _drained, ...queuedMessages } = state.queuedMessages;
  return { ...state, queuedMessages };
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
      status: state.activeRuns[parent.id]?.status ?? (threadBusy(state, parent.id) ? "running" : runStatusFor(state, parent.id)),
      lastRunOutcome: lastRunOutcome(parent) ?? null,
      workingAgents: workingAgents.length,
      // Identify the same helpers mentioned in inherited notices without copying their activity logs.
      workingAgentIds: workingAgents.slice(0, 16).map((agent) => agent.id),
    } : { status: "unknown" }),
  };
  return `Context for the side-chat question below (not an assignment):\n<parent-task-status>\n${JSON.stringify(status)}\n</parent-task-status>\nThis is the parent's state from the app when the question was sent. The helpers listed as working are running in the parent. The fork cannot resume those processes: any copied process-exited or lost-state notice describes that limitation of the fork, not a failure of the parent or its helpers. This status supplies no findings or failure cause; do not infer either from those notices.\n\n${prompt}`;
}

/** A composer that has just sent: text, annotations, pastes, images, and attached files all go. */
export function clearedDraft(state: WorkspaceState, draftKey: string): WorkspaceState {
  return withFiles(withImages(withPastes(withAnnotations(withPrompt(state, draftKey, ""), draftKey, []), draftKey, []), draftKey, []), draftKey, []);
}

function claudeRunSettings(state: WorkspaceState): ClaudeRunSettings | undefined {
  const settings = {
    ...(state.chromeBrowser ? { chromeBrowser: true as const } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function startRunCommand(state: WorkspaceState, thread: Thread, runId: string, prompt: string, workspaceId: string, policy = thread.executionPolicy): StartRunCommand {
  const claude = claudeRunSettings(state);
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
    policy,
    engine: thread.engine,
    model: thread.model ?? defaultModelFor(thread.engine),
    effort: effortForModel(thread.model ?? defaultModelFor(thread.engine), thread.effort ?? defaultEffortFor(thread.engine), coordination),
    ...(capabilitiesFor(thread.engine).fastMode ? { fastMode: thread.fastMode ?? false } : {}),
    ...(claude ? { claude } : {}),
    ...(state.computerUse ? {} : { computerUseTools: false as const }), ...(state.browserTools ? {} : { browserTools: false as const }),
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
 * limit lifted, and `agent` is a turn the agent opened itself.
 */
type RunPickup = "warming" | "agent";

/**
 * Records the run against the thread and marks it the thread's latest, so stale replies can be dropped.
 * The new run supersedes whatever the last one concluded, so how it ended, its verdict and the report
 * it made never outlive it, and it keeps where the thread stood, which is what a run that settles
 * unseen puts back.
 */
export function beginRun(state: WorkspaceState, taskId: string, runId: string, provenance: RunProvenance = ATTENDED_RUN, before?: ThreadMark, pickup?: RunPickup): WorkspaceState {
  /** A run that starts is the thread picked back up, whatever its place in line. */
  const threads = withoutOutcome(state.threads, new Set([taskId])).map((thread) => thread.id === taskId ? opened(pickedUp(thread, pickup), provenance) : thread);
  const messagesBefore = threads.find((thread) => thread.id === taskId)?.messages.length ?? 0;
  const mark = before ?? threadMark(state.threads.find((thread) => thread.id === taskId));
  /**
   * The turn the agent opens itself on hearing that what Stop all stopped has stopped ends quietly too;
   * any other run is the thread picked back up, and so is a turn of its own long after the stop, so
   * a later turn of the agent's own is news again.
   */
  const hushed = state.quietSessions.find((session) => session.taskId === taskId);
  const heard = hushed ? { quietSessions: state.quietSessions.filter((session) => session !== hushed) } : {};
  const answering = hushed && pickup === "agent" && answersInTime(hushed, now()) ? { answersStop: true as const } : {};
  return withRunStatus(
    withActiveRun({ ...state, ...heard, threads, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running", ...provenance, notified: false, acknowledged: false, reportedIssues: [], messagesBefore, before: mark, ...(pickup === "warming" ? { warming: true as const } : {}), ...answering }),
    taskId,
    "running",
  );
}

/** How long after Stop all stopped a thread's session work the agent's own turn is still its answer to that stop. */
const STOP_ANSWER_MS = 2 * 60_000;

/** Whether a turn the agent opens now could still be its answer to the stop that hushed its session. */
export function answersInTime(session: QuietSession, at: number): boolean {
  return at - session.at <= STOP_ANSWER_MS;
}

/**
 * A run is open on its thread until it ends, so one the app quits under is known as cut off when the
 * thread is restored. Compacting is not a turn, and a quiet scheduled run only speaks through what it
 * finds, so neither is.
 */
function opened(thread: Thread, provenance: Pick<RunProvenance, "origin" | "quiet" | "operation">): Thread {
  return provenance.operation === "compact" || provenance.origin === "automation" && provenance.quiet ? thread : { ...thread, runOpen: true };
}

function pickedUp(thread: Thread, pickup: RunPickup | undefined): Thread {
  const { runEndedAs: _superseded, ...rest } = thread;
  return withoutLimitPause(reportStands(thread, pickup) ? rest : withoutReport(rest));
}

/**
 * A run resuming after a usage limit carries on the turn the limit cut short, so what that turn
 * reported still stands. A turn the agent opened itself was answered by nobody, so a report that the
 * thread needs the user stands through it until the user writes or the agent reports again.
 */
function reportStands(thread: Thread, pickup: RunPickup | undefined) {
  return pickup === "warming" || pickup === "agent" && thread.report !== undefined && GROUP_OF[thread.report.state] === "needs";
}

/** A human who joins a scheduled run owns it from then on: what it finds is an answer to them, and the app quitting under it cuts their turn off. */
export function withAttendedRun(state: WorkspaceState, taskId: string): WorkspaceState {
  const active = state.activeRuns[taskId];
  if (!active || active.origin === "composer") return state;
  const attended = { ...active, origin: "composer" as const };
  return updateThread(withActiveRun(state, taskId, attended), taskId, (thread) => opened(thread, attended));
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
export function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return updateThread(withAttendedRun(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId), taskId, (thread) => ({
    ...thread,
    messages: [...thread.messages, createSentMessage(delivered)],
    updatedAt: now(),
  }));
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
export function cancellingRun(state: WorkspaceState, active: ActiveRun): WorkspaceTransition {
  const marked = active.cancelling ? state : withActiveRun(state, active.taskId, { ...active, cancelling: true });
  return settled(marked, [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }]);
}

/** The kill is the agent process's to make; the row only says a stop is on its way. */
export function stoppingProcess(state: WorkspaceState, taskId: string, processId: string): WorkspaceTransition {
  const stop: WorkspaceEffect[] = [{ type: "send-run-command", command: { type: "stop-process", taskId, processId } }];
  const processes = state.backgroundProcesses[taskId] ?? [];
  const target = processes.find((process) => process.id === processId);
  if (target) {
    const marked = processes.map((process) => process.id === target.id ? { ...process, stopping: true } : process);
    return target.stopping ? settled(state) : settled(withBackgroundProcesses(state, taskId, marked), stop);
  }
  /** A workflow is a task of the agent process like any other, so the same stop reaches it. */
  const workflows = state.workflows[taskId] ?? [];
  const workflow = workflows.find((candidate) => candidate.id === processId);
  if (workflow) {
    if (workflow.stopping || workflow.status !== "running") return settled(state);
    return settled(
      withWorkflows(state, taskId, workflows.map((candidate) => candidate.id === workflow.id ? { ...candidate, stopping: true } : candidate)),
      stop,
    );
  }
  /** So is a subagent the session is still running. */
  const subagents = state.subagents[taskId] ?? [];
  const subagent = subagents.find((candidate) => candidate.id === processId);
  if (!subagent || subagent.stopping || subagent.status !== "working") return settled(state);
  return settled(
    withSubagents(state, taskId, subagents.map((candidate) => candidate.id === subagent.id ? { ...candidate, stopping: true as const } : candidate)),
    stop,
  );
}

/**
 * Queued messages put back in the thread's composer, ahead of whatever is drafted there, with
 * everything they carry. The caller has already taken them out of the queue.
 */
export function handedBack(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceTransition {
  const text = [...messages.map((message) => message.text), state.prompts[taskId] ?? ""].filter(Boolean).join("\n\n");
  const annotations = [...messages.flatMap((message) => message.annotations ?? []), ...annotationsFor(state, taskId)];
  const pastes = [...messages.flatMap((message) => message.pastes ?? []), ...pastesFor(state, taskId)];
  const files = [...messages.flatMap((message) => message.files ?? []), ...filesFor(state, taskId)];
  const images = messages.flatMap((message) => message.attachments);
  const handed = withFiles(withPastes(withAnnotations(withPrompt(state, taskId, text), taskId, annotations), taskId, pastes), taskId, files);
  return images.length ? composerDraft(handed, { type: "image.recall", taskId, paths: [...images, ...imagesFor(state, taskId).map((image) => image.path)] }, taskId) : settled(handed);
}

/**
 * Queued messages that will never reach the thread. A decision one answers is open again, to be
 * answered anew, and a coordinator here that sent one hears it was not delivered. The caller has
 * already taken them out of the queue.
 */
export function withUndelivered(state: WorkspaceState, taskId: string, messages: readonly QueuedMessage[]): WorkspaceState {
  const recipient = state.threads.find((thread) => thread.id === taskId);
  if (!recipient) return state;
  let next = state;
  for (const { answers, origin, text } of messages) {
    if (answers !== undefined) next = updateThread(next, taskId, (thread) => withoutAnswer(thread, answers));
    const sender = origin?.kind === "thread" && origin.computer === undefined ? next.threads.find((thread) => thread.id === origin.threadId) : undefined;
    if (sender && isCoordinator(sender)) next = updateThread(next, sender.id, (lead) => withCoordinationNote(lead, undeliveredNote(recipient, text, now())));
  }
  return next;
}

/**
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped hands what they wrote
 * back to the composer instead of speaking for them, and nothing else queued is delivered.
 */
export function drainQueue(state: WorkspaceState, taskId: string, status: RunStatus, warming = false): WorkspaceTransition {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return settled(state);
  if (status === "cancelled") {
    const own = queued.filter(isUsersOwn);
    const left = withUndelivered(withQueued(state, taskId, []), taskId, queued.filter((message) => !isUsersOwn(message)));
    return own.length ? handedBack(left, taskId, own) : settled(left);
  }
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return settled(withQueued(state, taskId, []));
  /** A thread waiting out its usage limit keeps its queue until the limit lifts. */
  if (thread.limitPause) return settled(state);
  /** A thread moving into a checkout still being made keeps its queue until it lands there. */
  if (state.creatingWorktrees.includes(taskId)) return settled(state);
  const [next] = queued;
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
    ...(next.origin ? { messageOrigin: next.origin } : {}),
    queuedIds: [next.id],
    ...(warming ? { warming: true as const } : {}),
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(state, thread), false)]);
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

/**
 * Whether a thread is working, counting the moment between a send and the checkout it resolves to.
 * A run that has not started yet still has an answer on its way about where it will happen.
 */
export function threadBusy(state: WorkspaceState, taskId: string) {
  return Boolean(state.activeRuns[taskId]) || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId);
}

/** Whether a run is going in a checkout, so nothing moves the ground under it. */
export function runsInWorkspace(state: WorkspaceState, workspaceId: string | undefined) {
  if (!workspaceId) return false;
  return Object.keys(state.activeRuns).some((taskId) => {
    const thread = state.threads.find((item) => item.id === taskId);
    return thread ? threadWorkspaceId(state, thread) === workspaceId : false;
  });
}

export function withSideChat(state: WorkspaceState, chatId: string, update: (chat: SideChat) => SideChat): WorkspaceState {
  return { ...state, sideChats: state.sideChats.map((chat) => chat.id === chatId ? update(chat) : chat) };
}
