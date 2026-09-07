import { runStatusFor } from "./thread-run-state.js";
import { projectFor, worktreeFor } from "./thread-location.js";
import { sideChatIds, type WorkspaceState } from "./workspace-state.js";
import type { ProjectScope, ThreadFilter, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../contracts/threads.js";
import { findProject, projectName, type Project } from "../domain/project.js";
import { threadActivityAt, threadCreatedAt, type Thread } from "../domain/thread.js";
import { threadHandles, type ThreadHandleOption } from "../domain/thread-handles.js";
import type { Worktree } from "../domain/worktree.js";

/** Enough of a message to recognise what happened without carrying a whole transcript. */
const MESSAGE_TEXT_LIMIT = 2_000;
const DEFAULT_TRANSCRIPT_MESSAGES = 30;

export function resolveScope(state: WorkspaceState, callerThreadId: string, project?: string): ProjectScope | { error: string } {
  if (project === "all") return { kind: "all" };
  if (project === undefined || project === "current") {
    const projectId = state.threads.find((thread) => thread.id === callerThreadId)?.projectId;
    return projectId ? { kind: "project", projectId } : { kind: "projectless" };
  }
  const match = findProject(state.projects, project);
  return "error" in match ? { error: match.error } : { kind: "project", projectId: match.project.id };
}

/** A thread is working while a run is going, resolving, or still queued behind the one that is. */
export function threadBusy(state: WorkspaceState, threadId: string): boolean {
  return Boolean(state.activeRuns[threadId])
    || Object.values(state.pendingRuns).some((pending) => pending.taskId === threadId)
    || Boolean(state.queuedMessages[threadId]?.length);
}

export function threadWaitResult(state: WorkspaceState, threadId: string, timedOut: boolean): ThreadWaitResult | null {
  const thread = findThread(state, threadId);
  if (!thread) return null;
  let reply: string | null = null;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.kind !== "assistant") continue;
    reply = message.text;
    break;
  }
  return { thread: threadSummary(state, thread), timedOut, reply };
}

type ProjectionIndex = {
  projects: Map<string, Project>;
  worktrees: Map<string, Worktree>;
  busy: Set<string>;
};

/** Shared lookups for a whole thread listing. First wins, matching the array searches they replace. */
function projectionIndex(state: WorkspaceState): ProjectionIndex {
  const projects = new Map<string, Project>();
  for (const project of state.projects) if (!projects.has(project.id)) projects.set(project.id, project);
  const worktrees = new Map<string, Worktree>();
  for (const worktree of state.worktrees) if (!worktrees.has(worktree.id)) worktrees.set(worktree.id, worktree);
  const busy = new Set(Object.keys(state.activeRuns));
  for (const pending of Object.values(state.pendingRuns)) if (pending.taskId) busy.add(pending.taskId);
  for (const [threadId, queued] of Object.entries(state.queuedMessages)) if (queued.length) busy.add(threadId);
  return { projects, worktrees, busy };
}

function projectThreadSummary(state: WorkspaceState, thread: Thread, activity: number, index?: ProjectionIndex, attachments?: number): ThreadSummary {
  const project = index ? (thread.projectId ? index.projects.get(thread.projectId) : undefined) : projectFor(state, thread);
  const worktree = index ? (thread.worktreeId ? index.worktrees.get(thread.worktreeId) : undefined) : worktreeFor(state, thread);
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    ...(project ? { projectRoot: project.root } : {}),
    ...(worktree ? { worktreeId: worktree.id, worktreeRoot: worktree.root } : {}),
    status: (index ? index.busy.has(thread.id) : threadBusy(state, thread.id)) ? "running" : runStatusFor(state, thread.id),
    archived: thread.archivedAt !== undefined,
    createdAt: threadCreatedAt(thread),
    lastActivityAt: activity,
    messageCount: thread.historySummary?.messageCount ?? thread.messages.length,
    attachmentCount: attachments ?? countAttachments(thread),
  };
}

export function threadSummary(state: WorkspaceState, thread: Thread, index?: ProjectionIndex): ThreadSummary {
  return projectThreadSummary(state, thread, threadActivityAt(thread), index);
}

/** Newest activity first, so a limit keeps the threads worth looking at. */
export function threadSummaries(state: WorkspaceState, filter: ThreadFilter, at: number): ThreadSummary[] {
  const search = filter.search?.trim().toLowerCase();
  const forked = sideChatIds(state);
  if (filter.limit === undefined) {
    const matching: Array<{ thread: Thread; attachments?: number }> = [];
    for (const thread of state.threads) {
      if (forked.has(thread.id)) continue;
      if (!inScope(thread, filter.scope)) continue;
      if ((thread.archivedAt !== undefined) !== Boolean(filter.archived)) continue;
      if (filter.idleForMs !== undefined && at - threadActivityAt(thread) < filter.idleForMs) continue;
      if (search && !matches(thread, search)) continue;
      const attachments = filter.attachments ? countAttachments(thread) : undefined;
      if (filter.attachments && !attachments) continue;
      matching.push({ thread, ...(attachments === undefined ? {} : { attachments }) });
    }
    if (!matching.length) return [];
    const index = projectionIndex(state);
    return matching
      .map(({ thread, attachments }) => projectThreadSummary(state, thread, threadActivityAt(thread), index, attachments))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }
  const matching: Array<{ thread: Thread; activity: number; attachments?: number }> = [];
  for (const thread of state.threads) {
    if (forked.has(thread.id)) continue;
    if (!inScope(thread, filter.scope)) continue;
    if ((thread.archivedAt !== undefined) !== Boolean(filter.archived)) continue;
    let activity: number | undefined;
    if (filter.idleForMs !== undefined) {
      activity = threadActivityAt(thread);
      if (at - activity < filter.idleForMs) continue;
    }
    if (search && !matches(thread, search)) continue;
    const attachments = filter.attachments ? countAttachments(thread) : undefined;
    if (filter.attachments && !attachments) continue;
    matching.push({ thread, activity: activity ?? threadActivityAt(thread), ...(attachments === undefined ? {} : { attachments }) });
  }
  if (!matching.length || Math.max(0, filter.limit) === 0) return [];
  matching.sort((left, right) => right.activity - left.activity);
  const retained = matching.slice(0, Math.max(0, filter.limit));
  const index = projectionIndex(state);
  return retained.map(({ thread, activity, attachments }) => projectThreadSummary(state, thread, activity, index, attachments));
}

/**
 * The threads a draft may name, keyed by the draft rather than the thread, since a draft can be
 * older than the thread it starts. Every project is offered, since a query searches them all;
 * `inScope` is what keeps an unqualified `@` to the project the draft is being written in.
 */
export function threadHandleOptions(state: WorkspaceState, draftKey: string): ThreadHandleOption[] {
  const forked = sideChatIds(state);
  const index = projectionIndex(state);
  const caller = state.threads.find((thread) => thread.id === draftKey);
  /** A draft belonging to no thread yet is being written wherever the sidebar is pointed. */
  const projectId = caller ? caller.projectId ?? null : state.draftProjectId;
  return threadHandles(state.threads
    .filter((thread) => thread.id !== draftKey && !forked.has(thread.id) && thread.archivedAt === undefined)
    .map((thread) => {
      const project = thread.projectId ? index.projects.get(thread.projectId) : undefined;
      return {
        id: thread.id,
        title: thread.title,
        project: project ? projectName(project) : null,
        inScope: (thread.projectId ?? null) === projectId,
        running: index.busy.has(thread.id),
        lastActivityAt: threadActivityAt(thread),
      };
    }));
}

/** The thread a reference names: its id, an unambiguous id prefix, or its title. Newest wins. */
export function findThread(state: WorkspaceState, reference: string): Thread | null {
  const wanted = reference.trim().toLowerCase();
  if (!wanted) return null;
  let title: { thread: Thread; activity: number } | null = null;
  let prefix: { thread: Thread; activity: number } | null = null;
  for (const thread of state.threads) {
    const id = thread.id.toLowerCase();
    if (id === wanted) return thread;
    const titleMatches = thread.title.trim().toLowerCase() === wanted;
    const prefixMatches = id.startsWith(wanted);
    if (!titleMatches && !prefixMatches) continue;
    const activity = threadActivityAt(thread);
    if (titleMatches && (!title || activity > title.activity)) title = { thread, activity };
    if (prefixMatches && (!prefix || activity > prefix.activity)) prefix = { thread, activity };
  }
  return title?.thread ?? prefix?.thread ?? null;
}

export function threadTranscript(state: WorkspaceState, threadId: string, limit = DEFAULT_TRANSCRIPT_MESSAGES): ThreadTranscript | null {
  const thread = findThread(state, threadId);
  if (!thread) return null;
  const kept = limit >= thread.messages.length ? thread.messages : thread.messages.slice(thread.messages.length - Math.max(0, limit));
  return {
    thread: threadSummary(state, thread),
    messages: kept.map((message) => ({
      kind: message.kind,
      text: message.text.length > MESSAGE_TEXT_LIMIT ? `${message.text.slice(0, MESSAGE_TEXT_LIMIT)}…` : message.text,
      at: message.at,
    })),
    omitted: thread.messages.length - kept.length,
  };
}

function inScope(thread: Thread, scope: ProjectScope) {
  if (scope.kind === "all") return true;
  if (scope.kind === "projectless") return thread.projectId === undefined;
  return thread.projectId === scope.projectId;
}

function carriesAttachment(message: Thread["messages"][number]) {
  return Boolean(message.attachments?.length);
}

function countAttachments(thread: Thread) {
  if (thread.historySummary) return thread.historySummary.attachmentCount;
  let count = 0;
  for (const message of thread.messages) if (carriesAttachment(message)) count += 1;
  return count;
}

function matches(thread: Thread, search: string) {
  return thread.title.toLowerCase().includes(search) || thread.messages.some((message) => message.text.toLowerCase().includes(search));
}
