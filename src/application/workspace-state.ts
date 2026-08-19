import { runStatusFor, type ApprovalView, type RunTransitionState, type StreamingTail, type TaskRunStatus } from "./task-workspace.js";
import { backfillSortIndex, orderTasks } from "./task-order.js";
import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationView } from "../domain/automation.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type AgentModel, type ExecutionPolicy } from "../domain/run.js";
import { legacyProjectId, retainedTasks, type Project, type Task, type TaskStoreData } from "../domain/task.js";
import type { Worktree } from "../domain/worktree.js";

/**
 * A run the user or the scheduler asked for that is still resolving its workspace. It lives in state
 * rather than in a closure so the reducer can re-check the task when resolution lands.
 */
export type PendingRun = {
  id: string;
  runId: string;
  origin: "composer" | "automation";
  taskId?: string;
  projectId?: string;
  /** Composer only: which draft to clear once the run starts. */
  draftKey?: string;
  /** What the user typed, before attachments are appended. Titles a brand new task. */
  text: string;
  prompt: string;
  attachments: string[];
  detail?: string;
  policy?: ExecutionPolicy;
  automationId?: string;
  /** Queued messages this run is draining, cleared only once the run actually starts. */
  queuedIds?: string[];
};

/** Where a thread's runs happen, and whether a checkout of its own is still on its way. */
export type ThreadLocation =
  | { kind: "local" }
  | { kind: "pending" }
  | { kind: "worktree"; worktree: Worktree };

/**
 * Something the user typed while a run was going. It waits for the run to finish, unless it is
 * steered into that run first.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  prompt: string;
  attachments: string[];
  /** Set once steering is on its way to the agent, which is the point of no return. */
  steering?: boolean;
};

/**
 * One forked conversation. Its thread is an ordinary task in `tasks`, so everything keyed by a task
 * id — drafts, queued messages, approvals, steering — reaches it too. This record only marks the
 * task as one that is never persisted and never listed.
 */
export type SideChat = {
  id: string;
  sourceTaskId: string;
  error: string | null;
};

export type SideChatView = SideChat & {
  title: string;
  task: Task;
  prompt: string;
  running: boolean;
  compacting: boolean;
  status: TaskRunStatus;
  streamingTail: StreamingTail | null;
  queuedMessages: QueuedMessage[];
  approval?: ApprovalView;
};

/** The ids of every thread that only lives for this session. */
export function sideChatIds(state: Pick<WorkspaceState, "sideChats">) {
  return new Set(state.sideChats.map((chat) => chat.id));
}

export type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
  lastFolder: string | null;
  currentId: string | null;
  /** Threads the user has landed on this session, oldest first, with a cursor for back and forward. */
  history: string[];
  historyIndex: number;
  draftProjectId: string | null;
  draftPolicy: ExecutionPolicy;
  /** How the next new thread starts: which branch, and whether it gets a checkout of its own. */
  draftBranch: string | null;
  draftWorktree: boolean;
  draftModel: AgentModel;
  draftEffort: AgentEffort;
  prompts: Record<string, string>;
  expandedProjects: Set<string>;
  projectsOpen: boolean;
  recentsOpen: boolean;
  sessionPanelOpen: boolean;
  openMenu: string | null;
  environment: { workspaceId: string; result: ChangedFilesResult } | null;
  computerUseSetup: boolean;
  automations: AutomationView[];
  pendingRuns: Record<string, PendingRun>;
  queuedMessages: Record<string, QueuedMessage[]>;
  sideChats: SideChat[];
  sideChatSequence: number;
  /** Latest run per task, so a reply from a superseded run can be dropped. */
  lastRunIds: Record<string, string>;
  focused: boolean;
} & RunTransitionState & {
  storageError: string | null;
  actionError: string | null;
  writable: boolean;
};

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    tasks: [],
    projects: [],
    lastFolder: null,
    currentId: null,
    history: [],
    historyIndex: -1,
    draftProjectId: null,
    draftPolicy: "confirm",
    draftBranch: null,
    draftWorktree: false,
    draftModel: DEFAULT_MODEL,
    draftEffort: DEFAULT_EFFORT,
    prompts: {},
    expandedProjects: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    sessionPanelOpen: false,
    openMenu: null,
    environment: null,
    computerUseSetup: false,
    automations: [],
    pendingRuns: {},
    queuedMessages: {},
    sideChats: [],
    sideChatSequence: 0,
    lastRunIds: {},
    focused: true,
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    streamingTails: {},
    storageError,
    actionError: null,
    writable: storageError === null,
  };
}

export function stateFromData(data: TaskStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const tasks = retainedTasks(data.tasks, Date.now());
  const firstTask = tasks[0];
  const firstProject = firstTask?.projectId ?? (firstTask ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  return {
    ...emptyWorkspaceState(storageError),
    tasks: backfillSortIndex(tasks),
    projects,
    lastFolder: data.lastFolder,
    currentId: firstTask?.id ?? null,
    history: firstTask ? [firstTask.id] : [],
    historyIndex: firstTask ? 0 : -1,
    draftProjectId: firstProject,
    draftPolicy: firstTask?.executionPolicy ?? "confirm",
    draftModel: firstTask?.model ?? DEFAULT_MODEL,
    draftEffort: firstTask?.effort ?? DEFAULT_EFFORT,
    expandedProjects: new Set(firstProject ? [firstProject] : []),
  };
}

/** The slice of state that survives a restart, gathered here so persisting it stays one decision. */
export function viewPreferences(state: WorkspaceState): ViewPreferences {
  return { sessionPanelOpen: state.sessionPanelOpen };
}

export function projectFor(state: WorkspaceState, task: Task | undefined) {
  return task?.projectId ? state.projects.find((project) => project.id === task.projectId) : undefined;
}

/** Where a thread's runs happen: its own checkout once it has one, otherwise its project's. */
export function taskWorkspaceId(state: WorkspaceState, task: Task | undefined) {
  return task?.worktree?.workspaceId ?? projectFor(state, task)?.workspaceId;
}

export function locationOf(task: Task | undefined): ThreadLocation {
  if (task?.worktree) return { kind: "worktree", worktree: task.worktree };
  if (task?.worktreeWanted) return { kind: "pending" };
  return { kind: "local" };
}

/** Composer drafts live per task, with one draft per project for the not-yet-created task. */
export function promptKey(state: Pick<WorkspaceState, "currentId" | "draftProjectId">) {
  return state.currentId ?? `draft:${state.draftProjectId ?? ""}`;
}

export function withPrompt(state: WorkspaceState, key: string, prompt: string): WorkspaceState {
  if (prompt) return { ...state, prompts: { ...state.prompts, [key]: prompt } };
  const { [key]: _cleared, ...prompts } = state.prompts;
  return { ...state, prompts };
}

/** Where the cursor lands moving `step` through history, stepping over threads that are gone or archived. */
export function reachableVisit(state: WorkspaceState, step: -1 | 1): number | null {
  for (let index = state.historyIndex + step; index >= 0 && index < state.history.length; index += step) {
    const id = state.history[index];
    if (state.tasks.some((task) => task.id === id && task.archivedAt === undefined)) return index;
  }
  return null;
}

/** Remembers where the app took the user, dropping the forward entries the way a browser does. */
export function recordVisit(state: WorkspaceState, taskId: string): WorkspaceState {
  const history = state.history.slice(0, state.historyIndex + 1);
  if (history[history.length - 1] !== taskId) history.push(taskId);
  return { ...state, history, historyIndex: history.length - 1 };
}

export type WorkspaceView = ReturnType<typeof deriveView>;

/** Everything the UI reads, derived in one place so components never reach into raw state. */
export function deriveView(state: WorkspaceState) {
  const currentTask = state.tasks.find((task) => task.id === state.currentId);
  const currentProject = currentTask
    ? projectFor(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const forked = sideChatIds(state);
  const listedTasks = state.tasks.filter((task) => !forked.has(task.id));
  const visibleTasks = listedTasks.filter((task) => task.archivedAt === undefined);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const workspaceId = currentTask
    ? taskWorkspaceId(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined);
  const environment = workspaceId && state.environment?.workspaceId === workspaceId ? state.environment.result : null;
  return {
    tasks: listedTasks,
    projects: state.projects,
    orderedTasks: orderTasks(visibleTasks),
    archivedTasks: listedTasks.filter((task) => task.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!),
    recentTasks: visibleTasks.filter((task) => !task.projectId).sort((a, b) => b.updatedAt - a.updatedAt),
    currentTask,
    currentProject,
    folder: currentProject?.root ?? "",
    policy: currentTask?.executionPolicy ?? state.draftPolicy,
    model: currentTask?.model ?? state.draftModel,
    effort: currentTask?.effort ?? state.draftEffort,
    prompt: state.prompts[promptKey(state)] ?? "",
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    queuedMessages: (state.currentId ? state.queuedMessages[state.currentId] : undefined) ?? [],
    runningTaskIds: new Set(Object.keys(state.activeRuns)),
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    subagents: currentTask?.subagents ?? [],
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    automatedTaskIds: new Set(state.automations.map((automation) => automation.taskId)),
    worktreeTaskIds: new Set(listedTasks.filter((task) => task.worktree).map((task) => task.id)),
    location: locationOf(currentTask),
    draftBranch: state.draftBranch,
    draftWorktree: state.draftWorktree,
    environment,
    storageError: state.storageError,
    actionError: state.actionError,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    projectsOpen: state.projectsOpen,
    recentsOpen: state.recentsOpen,
    sessionPanelOpen: state.sessionPanelOpen,
    openMenu: state.openMenu,
    canGoBack: reachableVisit(state, -1) !== null,
    canGoForward: reachableVisit(state, 1) !== null,
    sideChats: state.sideChats.flatMap((chat): SideChatView[] => {
      const task = state.tasks.find((item) => item.id === chat.id);
      if (!task) return [];
      const active = state.activeRuns[chat.id];
      const approval = active?.status === "awaiting-approval" ? state.approvals[active.runId] as ApprovalView | undefined : undefined;
      return [{
        ...chat,
        title: task.title,
        task,
        prompt: state.prompts[chat.id] ?? "",
        running: Boolean(active),
        compacting: active?.status === "compacting",
        status: active ? "running" : runStatusFor(state, chat.id),
        streamingTail: state.streamingTails[chat.id] ?? null,
        queuedMessages: state.queuedMessages[chat.id] ?? [],
        ...(approval ? { approval } : {}),
      }];
    }),
  };
}
