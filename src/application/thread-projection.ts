import { runStatus } from "./run-record.js";
import { threadActivity } from "./thread-activity.js";
import { projectFor, worktreeFor } from "./thread-location.js";
import { sideChatIds, type WorkspaceState } from "./workspace-state.js";
import type { ProjectScope, ThreadFilter, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../contracts/threads.js";
import { findProject, projectName, type Project } from "../domain/project.js";
import { threadActivityAt, threadCreatedAt, type Thread } from "../domain/thread.js";
import { threadHandles, type ThreadHandleOption } from "../domain/thread-handles.js";
import type { Worktree } from "../domain/worktree.js";
import { messageLabel, type MessageOrigin } from "../domain/message-origin.js";

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
};

/** Shared lookups for a whole thread listing. First wins, matching the array searches they replace. */
function projectionIndex(state: WorkspaceState): ProjectionIndex {
  const projects = new Map<string, Project>();
  for (const project of state.projects) if (!projects.has(project.id)) projects.set(project.id, project);
  const worktrees = new Map<string, Worktree>();
  for (const worktree of state.worktrees) if (!worktrees.has(worktree.id)) worktrees.set(worktree.id, worktree);
  return { projects, worktrees };
}

function projectThreadSummary(state: WorkspaceState, thread: Thread, activity: number, index?: ProjectionIndex, attachments?: number): ThreadSummary {
  const project = index ? (thread.projectId ? index.projects.get(thread.projectId) : undefined) : projectFor(state, thread);
  const worktree = index ? (thread.worktreeId ? index.worktrees.get(thread.worktreeId) : undefined) : worktreeFor(state, thread);
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.role ? { role: thread.role } : {}),
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    ...(project ? { projectRoot: project.root } : {}),
    ...(worktree ? { worktreeId: worktree.id, worktreeRoot: worktree.root } : {}),
    status: threadActivity(state).working.has(thread.id) ? "running" : runStatus(state, thread.id),
    ...(thread.limitPause ? { pausedUntil: thread.limitPause.resetsAt } : {}),
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
      if (search && !matches(thread, search, filter.stored)) continue;
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
    if (search && !matches(thread, search, filter.stored)) continue;
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
  const { working } = threadActivity(state);
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
        running: working.has(thread.id),
        lastActivityAt: threadActivityAt(thread),
      };
    }));
}

/** How closely threads match a reference, closest first: no weaker match ever stands in a closer one's way. */
const MATCH_RANKS = 5;

/**
 * The threads a reference could mean, and how closely: the one whose id it is, else the live threads
 * it is the title of, else the live ones whose id it begins, then the same two among archived threads,
 * which a live thread always outranks. More than one is a reference too loose to act on.
 */
export function threadMatches(state: WorkspaceState, reference: string): { rank: number; threads: Thread[] } {
  const wanted = reference.trim().toLowerCase();
  const ranked: Thread[][] = Array.from({ length: MATCH_RANKS }, () => []);
  if (!wanted) return { rank: MATCH_RANKS, threads: [] };
  for (const thread of state.threads) {
    const id = thread.id.toLowerCase();
    if (id === wanted) return { rank: 0, threads: [thread] };
    const archived = thread.archivedAt === undefined ? 0 : 2;
    if (thread.title.trim().toLowerCase() === wanted) ranked[1 + archived]!.push(thread);
    else if (id.startsWith(wanted)) ranked[2 + archived]!.push(thread);
  }
  const rank = ranked.findIndex((threads) => threads.length > 0);
  return rank < 0 ? { rank: MATCH_RANKS, threads: [] } : { rank, threads: ranked[rank]! };
}

/** The thread a reference names: its id, or the one thread it most closely is the title or an id prefix of. */
export function findThread(state: WorkspaceState, reference: string): Thread | null {
  const { threads } = threadMatches(state, reference);
  return threads.length === 1 ? threads[0]! : null;
}

/** Where a message came from, in the words every surface shows. */
export function labelOf(message: { origin?: MessageOrigin; detail?: string }): { origin?: string } {
  const label = messageLabel(message);
  return label ? { origin: label } : {};
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
      ...(message.kind === "user" ? labelOf(message) : {}),
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

function matches(thread: Thread, search: string, stored: ReadonlySet<string> | undefined) {
  if (thread.title.toLowerCase().includes(search)) return true;
  return thread.historySummary ? Boolean(stored?.has(thread.id)) : thread.messages.some((message) => message.text.toLowerCase().includes(search));
}
