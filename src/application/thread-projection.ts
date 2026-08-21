import { runStatusFor } from "./task-workspace.js";
import { projectFor, sideChatIds, worktreeFor, type WorkspaceState } from "./workspace-state.js";
import type { ProjectScope, ThreadFilter, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../contracts/threads.js";
import { findProject, threadActivityAt, threadCreatedAt, type Task } from "../domain/task.js";

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
  const task = state.tasks.find((item) => item.id === threadId);
  if (!task) return null;
  const reply = [...task.messages].reverse().find((message) => message.kind === "assistant")?.text ?? null;
  return { thread: threadSummary(state, task), timedOut, reply };
}

export function threadSummary(state: WorkspaceState, task: Task): ThreadSummary {
  const project = projectFor(state, task);
  const worktree = worktreeFor(state, task);
  return {
    id: task.id,
    title: task.title,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(project ? { projectRoot: project.root } : {}),
    ...(worktree ? { worktreeId: worktree.id, worktreeRoot: worktree.root } : {}),
    status: threadBusy(state, task.id) ? "running" : runStatusFor(state, task.id),
    archived: task.archivedAt !== undefined,
    createdAt: threadCreatedAt(task),
    lastActivityAt: threadActivityAt(task),
    messageCount: task.messages.length,
    attachmentCount: task.messages.filter(carriesAttachment).length,
  };
}

/** Newest activity first, so a limit keeps the threads worth looking at. */
export function threadSummaries(state: WorkspaceState, filter: ThreadFilter, at: number): ThreadSummary[] {
  const search = filter.search?.trim().toLowerCase();
  const forked = sideChatIds(state);
  const matching = state.tasks.filter((task) => {
    if (forked.has(task.id)) return false;
    if (!inScope(task, filter.scope)) return false;
    if ((task.archivedAt !== undefined) !== Boolean(filter.archived)) return false;
    if (filter.idleForMs !== undefined && at - threadActivityAt(task) < filter.idleForMs) return false;
    if (search && !matches(task, search)) return false;
    if (filter.attachments && !task.messages.some(carriesAttachment)) return false;
    return true;
  });
  const summaries = matching.map((task) => threadSummary(state, task)).sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  return filter.limit === undefined ? summaries : summaries.slice(0, Math.max(0, filter.limit));
}

export function threadTranscript(state: WorkspaceState, threadId: string, limit = DEFAULT_TRANSCRIPT_MESSAGES): ThreadTranscript | null {
  const task = state.tasks.find((item) => item.id === threadId);
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

function inScope(task: Task, scope: ProjectScope) {
  if (scope.kind === "all") return true;
  if (scope.kind === "projectless") return task.projectId === undefined;
  return task.projectId === scope.projectId;
}

function carriesAttachment(message: Task["messages"][number]) {
  return Boolean(message.attachments?.length);
}

function matches(task: Task, search: string) {
  return task.title.toLowerCase().includes(search) || task.messages.some((message) => message.text.toLowerCase().includes(search));
}
