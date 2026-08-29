import { deriveView, type WorkspaceState } from "./workspace-state.js";
import { threadSummaries, threadTranscript } from "./thread-projection.js";
import { projectName, type Task } from "../domain/task.js";
import { orderTasks } from "./task-order.js";
import type { MobileDraftView, MobileMessage, MobilePatch, MobileProjectGroup, MobileThreadDelta, MobileThreadEntry, MobileThreadView, MobileView } from "../contracts/mobile.js";

/**
 * The phone's view, derived from workspace state alone, and the difference between two of them.
 * Nothing here reads state the desktop does not already derive, so a phone and the window in front
 * of the user can never disagree about what a thread is doing.
 */

/** How many threads the list carries. Far more than a phone scrolls, and still bounded. */
export const MOBILE_THREAD_LIMIT = 100;

/** How many messages of the open thread travel. Each one is cut to length by the transcript itself. */
export const MOBILE_TRANSCRIPT_MESSAGES = 40;

/** How much of an approval's tool input is carried. Enough to judge it, never a whole file. */
export const MOBILE_APPROVAL_DETAIL_LIMIT = 4_000;

export function emptyMobileView(): MobileView {
  return { groups: [], thread: null, draft: null, error: null };
}

/** Everything a phone reads, derived from workspace state alone. */
export function projectMobileView(state: WorkspaceState, at: number): MobileView {
  const view = deriveView(state);
  const summaries = threadSummaries(state, { scope: { kind: "all" }, limit: MOBILE_THREAD_LIMIT }, at);
  const unread = new Set(state.tasks.filter((task) => task.outcomeUnread).map((task) => task.id));
  const entries = new Map<string | null, MobileThreadEntry[]>();
  for (const summary of summaries) {
    const key = summary.projectId ?? null;
    const entry: MobileThreadEntry = {
      id: summary.id,
      title: summary.title || "Untitled thread",
      status: view.blockedTaskIds.has(summary.id) ? "awaiting-approval" : summary.status,
      lastActivityAt: summary.lastActivityAt,
      unread: unread.has(summary.id),
    };
    entries.get(key)?.push(entry) ?? entries.set(key, [entry]);
  }
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  /** Every open project is a group even with nothing in it, because a group is how a phone starts one. */
  const groups: MobileProjectGroup[] = view.projects.map((project) =>
    ({ projectId: project.id, name: projectName(project), threads: rankGroup(entries.get(project.id) ?? [], tasksById) }));
  /** Always last, and always there, because it is the only way to start a thread in no project. */
  groups.push({ projectId: null, name: "Recents", threads: rankGroup(entries.get(null) ?? [], tasksById) });
  const thread = projectMobileThread(state, view);
  return { groups, thread, draft: thread ? null : projectMobileDraft(view), error: state.actionError };
}

/**
 * One group's rows: threads waiting on the user first, then the rest in the sidebar's own order.
 * A thread holds its slot when it starts, speaks or finishes, so the list never reshuffles under
 * a thumb; only waiting on the user lifts a row. `entries` arrive newest first already.
 */
export function rankGroup(entries: MobileThreadEntry[], tasksById: Map<string, Task>): MobileThreadEntry[] {
  const blocked: MobileThreadEntry[] = [];
  const rest: MobileThreadEntry[] = [];
  for (const entry of entries) (entry.status === "awaiting-approval" ? blocked : rest).push(entry);
  const byTask = new Map(rest.map((entry) => [entry.id, entry]));
  const tasks = rest.flatMap((entry) => tasksById.get(entry.id) ?? []);
  return [...blocked, ...orderTasks(tasks).flatMap((task) => byTask.get(task.id) ?? [])];
}

/** What the desktop's empty composer is pointed at, which is all a thread yet to exist amounts to. */
function projectMobileDraft(view: ReturnType<typeof deriveView>): MobileDraftView {
  return {
    projectName: view.currentProject ? projectName(view.currentProject) : null,
    prompt: view.prompt,
    settings: { engine: view.engine, model: view.model, effort: view.effort, policy: view.policy },
  };
}

function projectMobileThread(state: WorkspaceState, view: ReturnType<typeof deriveView>): MobileThreadView | null {
  const task = view.currentTask;
  if (!task) return null;
  const transcript = threadTranscript(state, task.id, MOBILE_TRANSCRIPT_MESSAGES);
  if (!transcript) return null;
  const approval = view.approval;
  return {
    id: task.id,
    title: task.title || "Untitled thread",
    projectName: view.currentProject ? projectName(view.currentProject) : null,
    messages: transcript.messages,
    omitted: transcript.omitted,
    streamingTail: view.streamingTail?.text ?? null,
    status: view.blockedTaskIds.has(task.id) ? "awaiting-approval" : view.status,
    approval: approval
      ? {
        approvalId: approval.approvalId,
        runId: approval.runId,
        title: approval.title,
        description: approval.description,
        toolName: approval.toolName,
        detail: approvalDetail(approval.input),
      }
      : null,
    queued: view.queuedMessages.map((message) => ({ id: message.id, text: message.text })),
    prompt: view.prompt,
    settings: { engine: view.engine, model: view.model, effort: view.effort, policy: view.policy },
  };
}

function approvalDetail(input: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? "";
  } catch {
    text = "";
  }
  return text.length > MOBILE_APPROVAL_DETAIL_LIMIT ? `${text.slice(0, MOBILE_APPROVAL_DETAIL_LIMIT)}…` : text;
}

/** Null when nothing moved, so a server with nothing to say sends nothing at all. */
export function diffMobileView(previous: MobileView, next: MobileView): MobilePatch | null {
  const patch: MobilePatch = {};
  if (!same(previous.groups, next.groups)) patch.groups = next.groups;
  const thread = diffMobileThread(previous.thread, next.thread);
  if (thread) patch.thread = thread;
  if (!same(previous.draft, next.draft)) patch.draft = next.draft;
  if (previous.error !== next.error) patch.error = next.error;
  return Object.keys(patch).length ? patch : null;
}

function diffMobileThread(previous: MobileThreadView | null, next: MobileThreadView | null): MobilePatch["thread"] {
  if (!next) return previous ? { kind: "closed" } : undefined;
  if (!previous || previous.id !== next.id) return { kind: "opened", thread: next };
  const delta: MobileThreadDelta = {};
  if (previous.title !== next.title) delta.title = next.title;
  if (previous.projectName !== next.projectName) delta.projectName = next.projectName;
  if (previous.omitted !== next.omitted) delta.omitted = next.omitted;
  if (previous.streamingTail !== next.streamingTail) delta.streamingTail = next.streamingTail;
  if (previous.status !== next.status) delta.status = next.status;
  if (previous.prompt !== next.prompt) delta.prompt = next.prompt;
  if (!same(previous.approval, next.approval)) delta.approval = next.approval;
  if (!same(previous.queued, next.queued)) delta.queued = next.queued;
  if (!same(previous.settings, next.settings)) delta.settings = next.settings;
  const appended = appendedMessages(previous.messages, next.messages);
  if (appended === null) delta.messages = next.messages;
  else if (appended.length) delta.appended = appended;
  return Object.keys(delta).length ? { kind: "changed", id: next.id, delta } : undefined;
}

/** The messages added at the end, or null when the transcript changed in any other way. */
function appendedMessages(previous: MobileMessage[], next: MobileMessage[]): MobileMessage[] | null {
  if (next.length < previous.length) return null;
  for (let index = 0; index < previous.length; index += 1) {
    if (!same(previous[index], next[index])) return null;
  }
  return next.slice(previous.length);
}

/** Puts a patch back on the view the phone holds, which is the other half of {@link diffMobileView}. */
export function applyMobilePatch(view: MobileView, patch: MobilePatch): MobileView {
  const rest = {
    groups: patch.groups ?? view.groups,
    draft: "draft" in patch ? patch.draft ?? null : view.draft,
    error: "error" in patch ? patch.error ?? null : view.error,
  };
  if (!patch.thread) return { ...rest, thread: view.thread };
  if (patch.thread.kind === "closed") return { ...rest, thread: null };
  if (patch.thread.kind === "opened") return { ...rest, thread: patch.thread.thread };
  const current = view.thread;
  if (!current || current.id !== patch.thread.id) return { ...rest, thread: current };
  const { appended, messages, ...moved } = patch.thread.delta;
  return {
    ...rest,
    thread: {
      ...current,
      ...moved,
      messages: messages ?? (appended ? [...current.messages, ...appended] : current.messages),
    },
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
