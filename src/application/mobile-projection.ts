import { deriveView, type WorkspaceState } from "./workspace-state.js";
import { threadSummaries, threadTranscript } from "./thread-projection.js";
import { projectName, type Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { newestUnreadFinding, wantsAttention } from "../domain/attention.js";
import { DEFAULT_BRANCH_RANGE } from "../domain/diff.js";
import { themeFor, themeOrDefault } from "../domain/theme.js";
import { worktreeName } from "../domain/worktree.js";
import { activitySections, orderThreads } from "./thread-order.js";
import { projectFor, threadWorkspaceId } from "./thread-location.js";
import { diffFor } from "./workspace-diff.js";
import { workspaceViewCollections } from "./workspace-view-collections.js";
import type {
  MobileActivity,
  MobileChanges,
  MobileDraftView,
  MobileLocation,
  MobileMessage,
  MobilePatch,
  MobileProjectGroup,
  MobileTheme,
  MobileThreadDelta,
  MobileThreadEntry,
  MobileThreadView,
  MobileView,
  MobileWorktreeChoice,
} from "../contracts/mobile.js";

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
  return {
    groups: [],
    activity: { priority: [], running: [], threads: [] },
    theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" },
    thread: null,
    draft: null,
    error: null,
  };
}

/** Everything a phone reads, derived from workspace state alone. */
export function projectMobileView(state: WorkspaceState, at: number): MobileView {
  const view = deriveView(state);
  const summaries = threadSummaries(state, { scope: { kind: "all" }, limit: MOBILE_THREAD_LIMIT }, at);
  const threadsById = new Map(state.threads.map((thread) => [thread.id, thread]));
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const entries = new Map<string | null, MobileThreadEntry[]>();
  const entriesById = new Map<string, MobileThreadEntry>();
  for (const summary of summaries) {
    const key = summary.projectId ?? null;
    const thread = threadsById.get(summary.id);
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    const headline = thread ? newestUnreadFinding(thread)?.headline : undefined;
    const entry: MobileThreadEntry = {
      id: summary.id,
      title: summary.title || "Untitled thread",
      projectName: project ? projectName(project) : null,
      status: view.blockedThreadIds.has(summary.id) ? "awaiting-approval" : summary.status,
      lastActivityAt: summary.lastActivityAt,
      unread: Boolean(thread?.outcomeUnread) || headline !== undefined,
      ...(thread?.outcome ? { outcome: thread.outcome } : {}),
      ...(headline !== undefined ? { headline } : {}),
      attention: Boolean(thread && wantsAttention(thread)),
    };
    entries.get(key)?.push(entry) ?? entries.set(key, [entry]);
    entriesById.set(entry.id, entry);
  }
  /** Every open project is a group even with nothing in it, because a group is how a phone starts one. */
  const groups: MobileProjectGroup[] = view.projects.map((project) =>
    ({ projectId: project.id, name: projectName(project), threads: rankGroup(entries.get(project.id) ?? [], threadsById) }));
  /** Always last, and always there, because it is the only way to start a thread in no project. */
  groups.push({ projectId: null, name: "Recents", threads: rankGroup(entries.get(null) ?? [], threadsById) });
  const thread = projectMobileThread(state, view);
  return {
    groups,
    activity: projectMobileActivity(state, view, entriesById),
    theme: projectMobileTheme(state),
    thread,
    draft: thread ? null : projectMobileDraft(state, view),
    error: state.actionError,
  };
}

/**
 * The same three lists the desktop's activity sidebar draws, over the threads the list carries. A
 * thread past the list's limit is not ranked either: it is too old to be waiting on anyone.
 */
function projectMobileActivity(state: WorkspaceState, view: ReturnType<typeof deriveView>, entriesById: Map<string, MobileThreadEntry>): MobileActivity {
  const { visibleThreads } = workspaceViewCollections(state);
  const listed = visibleThreads.filter((thread) => entriesById.has(thread.id));
  const sections = activitySections(listed, view.runningThreadIds, view.blockedThreadIds);
  const rows = (threads: Thread[]) => threads.flatMap((thread) => entriesById.get(thread.id) ?? []);
  return { priority: rows(sections.priority), running: rows(sections.running), threads: rows(sections.threads) };
}

/** The desktop's family in both faces, so a phone on "auto" can pick its own without asking. */
export function projectMobileTheme(state: Pick<WorkspaceState, "theme" | "themeMode">): MobileTheme {
  const family = themeOrDefault(state.theme).family;
  return { dark: themeFor(family, "dark").id, light: themeFor(family, "light").id, mode: state.themeMode };
}

/**
 * One group's rows: threads waiting on the user first, then the rest in the sidebar's own order.
 * A thread holds its slot when it starts, speaks or finishes, so the list never reshuffles under
 * a thumb; only waiting on the user lifts a row. `entries` arrive newest first already.
 */
export function rankGroup(entries: MobileThreadEntry[], threadsById: Map<string, Thread>): MobileThreadEntry[] {
  const blocked: MobileThreadEntry[] = [];
  const rest: MobileThreadEntry[] = [];
  for (const entry of entries) (entry.status === "awaiting-approval" ? blocked : rest).push(entry);
  const byThread = new Map(rest.map((entry) => [entry.id, entry]));
  const threads = rest.flatMap((entry) => threadsById.get(entry.id) ?? []);
  return [...blocked, ...orderThreads(threads).flatMap((thread) => byThread.get(thread.id) ?? [])];
}

/** What the desktop's empty composer is pointed at, which is all a thread yet to exist amounts to. */
function projectMobileDraft(state: WorkspaceState, view: ReturnType<typeof deriveView>): MobileDraftView {
  const project = view.currentProject;
  return {
    projectId: project?.id ?? null,
    projectName: project ? projectName(project) : null,
    prompt: view.prompt,
    settings: { engine: view.engine, model: view.model, effort: view.effort, fastMode: view.fastMode, policy: view.policy },
    worktree: view.draftWorktree,
    worktreeName: view.draftWorktreeName,
    worktrees: project ? worktreeChoices(state, project, view.draftWorktreeId ?? undefined) : [],
    canWorktree: Boolean(project?.workspaceId),
  };
}

/** The project's checkouts a phone can name, most recently used first, without the one it is in. */
function worktreeChoices(state: WorkspaceState, project: Project, except: string | undefined): MobileWorktreeChoice[] {
  const managed = state.managedWorktrees ? new Map(state.managedWorktrees.map((item) => [item.root, item])) : null;
  const deleting = new Set(state.deletingWorktrees);
  return state.worktrees
    .filter((worktree) => worktree.projectId === project.id && worktree.id !== except && !deleting.has(worktree.root))
    .filter((worktree) => !managed || managed.get(worktree.root)?.repository)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .map((worktree) => {
      const environment = state.environments[worktree.workspaceId];
      const branch = environment?.status === "available" ? environment.branch : managed?.get(worktree.root)?.branch ?? null;
      return { id: worktree.id, name: worktreeName(worktree), branch };
    });
}

function locationOf(view: ReturnType<typeof deriveView>): MobileLocation {
  const location = view.location;
  if (location.kind !== "worktree") return { kind: location.kind };
  return { kind: "worktree", name: worktreeName(location.worktree), threads: location.threads };
}

function changesOf(view: ReturnType<typeof deriveView>): MobileChanges | null {
  const environment = view.environment;
  if (environment?.status !== "available") return null;
  return { branch: environment.branch, files: environment.files.length, additions: environment.additions, deletions: environment.deletions };
}

function projectMobileThread(state: WorkspaceState, view: ReturnType<typeof deriveView>): MobileThreadView | null {
  const thread = view.currentThread;
  if (!thread) return null;
  const transcript = threadTranscript(state, thread.id, MOBILE_TRANSCRIPT_MESSAGES);
  if (!transcript) return null;
  const approval = view.approval;
  const project = projectFor(state, thread);
  const diff = diffFor(state, thread.id);
  const location = locationOf(view);
  return {
    id: thread.id,
    loading: Boolean(thread.historySummary),
    title: thread.title || "Untitled thread",
    projectId: project?.id ?? null,
    projectName: view.currentProject ? projectName(view.currentProject) : null,
    worktreeId: thread.worktreeId ?? null,
    messages: transcript.messages,
    omitted: transcript.omitted,
    streamingTail: view.streamingTail?.text ?? null,
    status: view.blockedThreadIds.has(thread.id) ? "awaiting-approval" : view.status,
    question: view.question ?? null,
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
    queued: view.queuedMessages.map((message) => ({ id: message.id, text: message.text, ...(message.steering ? { steering: true } : {}) })),
    prompt: view.prompt,
    settings: { engine: view.engine, model: view.model, effort: view.effort, fastMode: view.fastMode, policy: view.policy },
    location,
    worktrees: project ? worktreeChoices(state, project, thread.worktreeId) : [],
    canMove: Boolean(project?.workspaceId) && location.kind !== "creating" && location.kind !== "releasing" && !view.runningThreadIds.has(thread.id),
    changes: changesOf(view),
    reviewable: threadWorkspaceId(state, thread) !== undefined,
    branchRange: diff.range.kind === "branches" ? diff.range : diff.branchRange ?? DEFAULT_BRANCH_RANGE,
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
  if (!same(previous.activity, next.activity)) patch.activity = next.activity;
  if (!same(previous.theme, next.theme)) patch.theme = next.theme;
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
  for (const key of MOVING_KEYS) {
    if (!same(previous[key], next[key])) (delta as Record<string, unknown>)[key] = next[key];
  }
  const appended = appendedMessages(previous.messages, next.messages);
  if (appended === null) delta.messages = next.messages;
  else if (appended.length) delta.appended = appended;
  return Object.keys(delta).length ? { kind: "changed", id: next.id, delta } : undefined;
}

/** Every field of the open thread a delta can carry, which is all of them but its id and its transcript. */
const MOVING_KEYS = [
  "loading", "title", "projectId", "projectName", "worktreeId", "omitted", "streamingTail", "status", "prompt", "question", "approval",
  "queued", "settings", "location", "worktrees", "canMove", "changes", "reviewable", "branchRange",
] as const satisfies ReadonlyArray<keyof Omit<MobileThreadView, "id" | "messages">>;

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
    activity: patch.activity ?? view.activity,
    theme: patch.theme ?? view.theme,
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
