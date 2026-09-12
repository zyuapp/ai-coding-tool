/** Starting a run: the prompt it carries, the checkout it asks for, and the messages waiting behind it. */
import { now, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { promptWithAnnotations } from "../annotations.js";
import { promptWithAttachments } from "../attachments.js";
import { annotationsFor, composerDraft, filesFor, imagesFor, pastesFor, withAnnotations, withFiles, withImages, withPastes } from "../composer-drafts.js";
import { promptWithFiles } from "../files.js";
import { promptWithPastes } from "../pastes.js";
import { ATTENDED_RUN, runStatusFor, threadMark, updateThread, withActiveRun, withRunStatus, type RunProvenance, type ThreadMark } from "../thread-run-state.js";
import { projectFor, threadWorkspaceId, worktreeFor } from "../thread-location.js";
import { withPrompt, type DraftBranch, type PendingRun, type QueuedMessage, type SideChat, type WorkspaceState } from "../workspace-state.js";
import type { ClaudeRunSettings, StartRunCommand } from "../../contracts/ipc.js";
import { withoutOutcome } from "../../domain/attention.js";
import { capabilitiesFor, defaultEffortFor, defaultModelFor, effortForModel } from "../../domain/agent-engine.js";
import type { RunStatus } from "../../domain/run.js";
import { createConversationMessage, type Annotation, type AttachedFile, type PastedText, type RunAttachment } from "../../domain/conversation.js";
import type { Project } from "../../domain/project.js";
import type { Thread } from "../../domain/thread.js";
import type { Worktree } from "../../domain/worktree.js";

export function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
}

export function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
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
      lastRunOutcome: parent.outcome ?? null,
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
    ...(state.conciseReplies ? { conciseReplies: true as const } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function startRunCommand(state: WorkspaceState, thread: Thread, runId: string, prompt: string, workspaceId: string, policy = thread.executionPolicy): StartRunCommand {
  const claude = claudeRunSettings(state);
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
    effort: effortForModel(thread.model ?? defaultModelFor(thread.engine), thread.effort ?? defaultEffortFor(thread.engine)),
    ...(capabilitiesFor(thread.engine).fastMode ? { fastMode: thread.fastMode ?? false } : {}),
    ...(claude ? { claude } : {}),
    ...(state.computerUse ? {} : { computerUseTools: false as const }), ...(state.browserTools ? {} : { browserTools: false as const }),
    ...(thread.continuation ? { continuation: thread.continuation } : {}),
    ...(thread.continuation && thread.inheritedContinuation ? { forkContinuation: true as const } : {}),
  };
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
 * Records the run against the thread and marks it the thread's latest, so stale replies can be dropped.
 * The new run supersedes whatever the last one concluded, so its verdict never outlives it, and it
 * keeps where the thread stood, which is what a run that settles unseen puts back.
 */
export function beginRun(state: WorkspaceState, taskId: string, runId: string, provenance: RunProvenance = ATTENDED_RUN, before?: ThreadMark): WorkspaceState {
  const threads = withoutOutcome(state.threads, new Set([taskId]));
  const messagesBefore = threads.find((thread) => thread.id === taskId)?.messages.length ?? 0;
  const mark = before ?? threadMark(state.threads.find((thread) => thread.id === taskId));
  return withRunStatus(
    withActiveRun({ ...state, threads, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running", ...provenance, notified: false, acknowledged: false, reportedIssues: [], messagesBefore, before: mark }),
    taskId,
    "running",
  );
}

/** A human who joins a scheduled run owns it from then on: what it finds is an answer to them. */
export function withAttendedRun(state: WorkspaceState, taskId: string): WorkspaceState {
  const active = state.activeRuns[taskId];
  if (!active || active.origin === "composer") return state;
  return withActiveRun(state, taskId, { ...active, origin: "composer" });
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
export function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return updateThread(withAttendedRun(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId), taskId, (thread) => ({
    ...thread,
    messages: [...thread.messages, createConversationMessage("user", delivered.text, undefined, delivered.attachments, delivered.annotations, delivered.pastes, delivered.files)],
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
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped hands the whole queue
 * back to the composer instead of speaking for them.
 */
export function drainQueue(state: WorkspaceState, taskId: string, status: RunStatus): WorkspaceTransition {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return settled(state);
  if (status === "cancelled") {
    const text = [...queued.map((message) => message.text), state.prompts[taskId] ?? ""].filter(Boolean).join("\n\n");
    const annotations = [...queued.flatMap((message) => message.annotations ?? []), ...annotationsFor(state, taskId)];
    const pastes = [...queued.flatMap((message) => message.pastes ?? []), ...pastesFor(state, taskId)];
    const files = [...queued.flatMap((message) => message.files ?? []), ...filesFor(state, taskId)];
    const images = queued.flatMap((message) => message.attachments);
    const handed = withFiles(withPastes(withAnnotations(withPrompt(withQueued(state, taskId, []), taskId, text), taskId, annotations), taskId, pastes), taskId, files);
    return images.length ? composerDraft(handed, { type: "image.recall", taskId, paths: [...images, ...imagesFor(state, taskId).map((image) => image.path)] }, taskId) : settled(handed);
  }
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return settled(withQueued(state, taskId, []));
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
    queuedIds: [next.id],
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
