import { runStatusFor } from "./task-workspace.js";
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

export function resolveScope(state: WorkspaceState, callerTaskId: string, project?: string): ProjectScope | { error: string } {
  if (project === "all") return { kind: "all" };
  if (project === undefined || project === "current") {
    const projectId = state.tasks.find((task) => task.id === callerTaskId)?.projectId;
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
  const task = findThread(state, threadId);
  if (!task) return null;
  let reply: string | null = null;
  for (let index = task.messages.length - 1; index >= 0; index -= 1) {
    const message = task.messages[index]!;
    if (message.kind !== "assistant") continue;
    reply = message.text;
    break;
  }
  return { thread: threadSummary(state, task), timedOut, reply };
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
  for (const [taskId, queued] of Object.entries(state.queuedMessages)) if (queued.length) busy.add(taskId);
  return { projects, worktrees, busy };
}

function projectThreadSummary(state: WorkspaceState, task: Thread, activity: number, index?: ProjectionIndex, attachments?: number): ThreadSummary {
  const project = index ? (task.projectId ? index.projects.get(task.projectId) : undefined) : projectFor(state, task);
  const worktree = index ? (task.worktreeId ? index.worktrees.get(task.worktreeId) : undefined) : worktreeFor(state, task);
  return {
    id: task.id,
    title: task.title,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(project ? { projectRoot: project.root } : {}),
    ...(worktree ? { worktreeId: worktree.id, worktreeRoot: worktree.root } : {}),
    status: (index ? index.busy.has(task.id) : threadBusy(state, task.id)) ? "running" : runStatusFor(state, task.id),
    archived: task.archivedAt !== undefined,
    createdAt: threadCreatedAt(task),
    lastActivityAt: activity,
    messageCount: task.messages.length,
    attachmentCount: attachments ?? countAttachments(task),
  };
}

export function threadSummary(state: WorkspaceState, task: Thread, index?: ProjectionIndex): ThreadSummary {
  return projectThreadSummary(state, task, threadActivityAt(task), index);
}

/** Newest activity first, so a limit keeps the threads worth looking at. */
export function threadSummaries(state: WorkspaceState, filter: ThreadFilter, at: number): ThreadSummary[] {
  const search = filter.search?.trim().toLowerCase();
  const forked = sideChatIds(state);
  if (filter.limit === undefined) {
    const matching: Array<{ task: Thread; attachments?: number }> = [];
    for (const task of state.tasks) {
      if (forked.has(task.id)) continue;
      if (!inScope(task, filter.scope)) continue;
      if ((task.archivedAt !== undefined) !== Boolean(filter.archived)) continue;
      if (filter.idleForMs !== undefined && at - threadActivityAt(task) < filter.idleForMs) continue;
      if (search && !matches(task, search)) continue;
      const attachments = filter.attachments ? countAttachments(task) : undefined;
      if (filter.attachments && !attachments) continue;
      matching.push({ task, ...(attachments === undefined ? {} : { attachments }) });
    }
    if (!matching.length) return [];
    const index = projectionIndex(state);
    return matching
      .map(({ task, attachments }) => projectThreadSummary(state, task, threadActivityAt(task), index, attachments))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }
  const matching: Array<{ task: Thread; activity: number; attachments?: number }> = [];
  for (const task of state.tasks) {
    if (forked.has(task.id)) continue;
    if (!inScope(task, filter.scope)) continue;
    if ((task.archivedAt !== undefined) !== Boolean(filter.archived)) continue;
    let activity: number | undefined;
    if (filter.idleForMs !== undefined) {
      activity = threadActivityAt(task);
      if (at - activity < filter.idleForMs) continue;
    }
    if (search && !matches(task, search)) continue;
    const attachments = filter.attachments ? countAttachments(task) : undefined;
    if (filter.attachments && !attachments) continue;
    matching.push({ task, activity: activity ?? threadActivityAt(task), ...(attachments === undefined ? {} : { attachments }) });
  }
  if (!matching.length || Math.max(0, filter.limit) === 0) return [];
  matching.sort((left, right) => right.activity - left.activity);
  const retained = matching.slice(0, Math.max(0, filter.limit));
  const index = projectionIndex(state);
  return retained.map(({ task, activity, attachments }) => projectThreadSummary(state, task, activity, index, attachments));
}

/**
 * The threads a draft may name, keyed by the draft rather than the thread, since a draft can be
 * older than the thread it starts. Every project is offered, since a query searches them all;
 * `inScope` is what keeps an unqualified `@` to the project the draft is being written in.
 */
export function threadHandleOptions(state: WorkspaceState, draftKey: string): ThreadHandleOption[] {
  const forked = sideChatIds(state);
  const index = projectionIndex(state);
  const caller = state.tasks.find((task) => task.id === draftKey);
  /** A draft belonging to no thread yet is being written wherever the sidebar is pointed. */
  const projectId = caller ? caller.projectId ?? null : state.draftProjectId;
  return threadHandles(state.tasks
    .filter((task) => task.id !== draftKey && !forked.has(task.id) && task.archivedAt === undefined)
    .map((task) => {
      const project = task.projectId ? index.projects.get(task.projectId) : undefined;
      return {
        id: task.id,
        title: task.title,
        project: project ? projectName(project) : null,
        inScope: (task.projectId ?? null) === projectId,
        running: index.busy.has(task.id),
        lastActivityAt: threadActivityAt(task),
      };
    }));
}

/** The thread a reference names: its id, an unambiguous id prefix, or its title. Newest wins. */
export function findThread(state: WorkspaceState, reference: string): Thread | null {
  const wanted = reference.trim().toLowerCase();
  if (!wanted) return null;
  let title: { task: Thread; activity: number } | null = null;
  let prefix: { task: Thread; activity: number } | null = null;
  for (const task of state.tasks) {
    const id = task.id.toLowerCase();
    if (id === wanted) return task;
    const titleMatches = task.title.trim().toLowerCase() === wanted;
    const prefixMatches = id.startsWith(wanted);
    if (!titleMatches && !prefixMatches) continue;
    const activity = threadActivityAt(task);
    if (titleMatches && (!title || activity > title.activity)) title = { task, activity };
    if (prefixMatches && (!prefix || activity > prefix.activity)) prefix = { task, activity };
  }
  return title?.task ?? prefix?.task ?? null;
}

export function threadTranscript(state: WorkspaceState, threadId: string, limit = DEFAULT_TRANSCRIPT_MESSAGES): ThreadTranscript | null {
  const task = findThread(state, threadId);
  if (!task) return null;
  const kept = limit >= task.messages.length ? task.messages : task.messages.slice(task.messages.length - Math.max(0, limit));
  return {
    thread: threadSummary(state, task),
    messages: kept.map((message) => ({
      kind: message.kind,
      text: message.text.length > MESSAGE_TEXT_LIMIT ? `${message.text.slice(0, MESSAGE_TEXT_LIMIT)}…` : message.text,
      at: message.at,
    })),
    omitted: task.messages.length - kept.length,
  };
}

function inScope(task: Thread, scope: ProjectScope) {
  if (scope.kind === "all") return true;
  if (scope.kind === "projectless") return task.projectId === undefined;
  return task.projectId === scope.projectId;
}

function carriesAttachment(message: Thread["messages"][number]) {
  return Boolean(message.attachments?.length);
}

function countAttachments(task: Thread) {
  let count = 0;
  for (const message of task.messages) if (carriesAttachment(message)) count += 1;
  return count;
}

function matches(task: Thread, search: string) {
  return task.title.toLowerCase().includes(search) || task.messages.some((message) => message.text.toLowerCase().includes(search));
}
