import { backfillProjectSortIndex } from "./project-order.js";
import { backfillSortIndex } from "./thread-order.js";
import { restoredThreads, withCutOffTurnsEnded } from "./thread-restore.js";
import { emptyWorkspaceState, sideChatIds, type WorkspaceState } from "./workspace-state.js";
import { DEFAULT_ENGINE, DEFAULT_MODEL } from "../domain/agent-engine.js";
import { coordinatorOf } from "../domain/coordination.js";
import { legacyProjectId } from "../domain/project.js";
import { DEFAULT_EFFORT } from "../domain/run.js";
import { retainedThreads } from "../domain/thread-retention.js";
import type { ThreadStoreData } from "../domain/thread-storage.js";

/** The workspace a store answer opens on, with its threads restored and any turn the last session cut off ended. */
export function stateFromData(data: ThreadStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const at = Date.now();
  const { threads, subagents, cutOff } = restoredThreads(retainedThreads(data.tasks, at));
  /** A thread under a coordinator is shown in the coordinator's dock, so the app never opens on one. */
  const firstThread = threads.find((thread) => !coordinatorOf(threads, thread));
  const firstProject = firstThread?.projectId ?? (firstThread ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  const restored: WorkspaceState = {
    ...emptyWorkspaceState(storageError),
    threads: backfillSortIndex(threads),
    subagents,
    projects: backfillProjectSortIndex(projects),
    /** A store answering from an older build has no checkouts to hand over. */
    worktrees: data.worktrees ?? [],
    lastFolder: data.lastFolder,
    currentId: firstThread?.id ?? null,
    history: firstThread ? [firstThread.id] : [],
    historyIndex: firstThread ? 0 : -1,
    draftProjectId: firstProject,
    draftPolicy: firstThread?.executionPolicy ?? "confirm",
    draftEngine: firstThread?.engine ?? DEFAULT_ENGINE,
    draftModel: firstThread?.model ?? DEFAULT_MODEL,
    draftEffort: firstThread?.effort ?? DEFAULT_EFFORT,
    draftFastMode: firstThread?.fastMode ?? false,
    expandedProjects: new Set(firstProject ? [firstProject] : []),
  };
  return withCutOffTurnsEnded(restored, cutOff, at);
}

/**
 * The store answering the load a session opened with. The window is live and typed into while the
 * store is read, so threads and projects arrive into the session rather than replacing it: a draft,
 * an annotation, a run on its way out and a run already going all outlive the arrival.
 */
export function withStoreData(state: WorkspaceState, data: ThreadStoreData): WorkspaceState {
  const landing = stateFromData(data);
  /** Threads the answer cannot know about: a fork, which is never stored, and one just started here. */
  const held = sideChatIds(state);
  for (const taskId in state.activeRuns) held.add(taskId);
  for (const pendingId in state.pendingRuns) if (state.pendingRuns[pendingId]!.taskId) held.add(state.pendingRuns[pendingId]!.taskId!);
  for (const taskId of state.creatingWorktrees) held.add(taskId);
  const stored = new Set<string>(); for (const thread of landing.threads) stored.add(thread.id);
  const threads = [...landing.threads, ...state.threads.filter((thread) => held.has(thread.id) && !stored.has(thread.id))];
  const landingWorktreeIds = new Set<string>(); for (const worktree of landing.worktrees) landingWorktreeIds.add(worktree.id);
  const claimedWorktreeIds = new Set<string>(); for (const thread of threads) if (thread.worktreeId) claimedWorktreeIds.add(thread.worktreeId);
  /** A checkout the store has yet to hear about is still claimed here, so the session keeps its record. */
  const arrived: WorkspaceState = {
    ...state,
    threads,
    /** A thread the session is already following keeps its live feed; the rest take the stored one. */
    subagents: { ...landing.subagents, ...state.subagents },
    worktrees: [
      ...landing.worktrees,
      ...state.worktrees.filter((worktree) => !landingWorktreeIds.has(worktree.id) && claimedWorktreeIds.has(worktree.id)),
    ],
    projects: landing.projects,
    lastFolder: landing.lastFolder,
    storageError: landing.storageError,
    writable: landing.writable,
  };
  if (sessionStarted(arrived)) return arrived;
  return {
    ...arrived,
    currentId: landing.currentId,
    history: landing.history,
    historyIndex: landing.historyIndex,
    draftProjectId: landing.draftProjectId,
    draftPolicy: landing.draftPolicy,
    draftEngine: landing.draftEngine,
    draftModel: landing.draftModel,
    draftEffort: landing.draftEffort,
    draftFastMode: landing.draftFastMode,
    expandedProjects: landing.expandedProjects,
  };
}

/**
 * Whether the session has gone anywhere of its own: it holds a thread, a project, a draft, or a run.
 * Only a session that has not takes the thread and the draft answers the store implies.
 */
function sessionStarted(state: WorkspaceState): boolean {
  return (state.currentId !== null && state.threads.some((thread) => thread.id === state.currentId))
    || state.draftProjectId !== null
    || Object.keys(state.prompts).length > 0
    || Object.keys(state.annotations).length > 0
    || Object.keys(state.pastes).length > 0
    || Object.keys(state.images).length > 0
    || Object.keys(state.files).length > 0
    || Object.keys(state.pendingRuns).length > 0;
}
