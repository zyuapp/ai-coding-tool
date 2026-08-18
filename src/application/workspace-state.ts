import { runStatusFor, type ApprovalView, type RunTransitionState } from "./task-workspace.js";
import { backfillSortIndex, orderTasks } from "./task-order.js";
import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { AutomationView } from "../domain/automation.js";
import { DEFAULT_MODEL, type AgentModel, type ExecutionPolicy } from "../domain/run.js";
import { legacyProjectId, type Project, type Task, type TaskStoreData } from "../domain/task.js";

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
};

export type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
  lastFolder: string | null;
  currentId: string | null;
  draftProjectId: string | null;
  draftPolicy: ExecutionPolicy;
  draftModel: AgentModel;
  prompts: Record<string, string>;
  expandedProjects: Set<string>;
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  environment: { workspaceId: string; result: ChangedFilesResult } | null;
  computerUseSetup: boolean;
  automations: AutomationView[];
  pendingRuns: Record<string, PendingRun>;
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
    draftProjectId: null,
    draftPolicy: "confirm",
    draftModel: DEFAULT_MODEL,
    prompts: {},
    expandedProjects: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    environment: null,
    computerUseSetup: false,
    automations: [],
    pendingRuns: {},
    lastRunIds: {},
    focused: true,
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    storageError,
    actionError: null,
    writable: storageError === null,
  };
}

export function stateFromData(data: TaskStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const firstTask = data.tasks[0];
  const firstProject = firstTask?.projectId ?? (firstTask ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  return {
    ...emptyWorkspaceState(storageError),
    tasks: backfillSortIndex(data.tasks),
    projects,
    lastFolder: data.lastFolder,
    currentId: firstTask?.id ?? null,
    draftProjectId: firstProject,
    draftPolicy: firstTask?.executionPolicy ?? "confirm",
    draftModel: firstTask?.model ?? DEFAULT_MODEL,
    expandedProjects: new Set(firstProject ? [firstProject] : []),
  };
}

export function projectFor(state: WorkspaceState, task: Task | undefined) {
  return task?.projectId ? state.projects.find((project) => project.id === task.projectId) : undefined;
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

export type WorkspaceView = ReturnType<typeof deriveView>;

/** Everything the UI reads, derived in one place so components never reach into raw state. */
export function deriveView(state: WorkspaceState) {
  const currentTask = state.tasks.find((task) => task.id === state.currentId);
  const currentProject = currentTask
    ? projectFor(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const visibleTasks = state.tasks.filter((task) => task.archivedAt === undefined);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const environment = currentProject?.workspaceId && state.environment?.workspaceId === currentProject.workspaceId ? state.environment.result : null;
  return {
    tasks: state.tasks,
    projects: state.projects,
    orderedTasks: orderTasks(visibleTasks),
    recentTasks: visibleTasks.filter((task) => !task.projectId).sort((a, b) => b.updatedAt - a.updatedAt),
    currentTask,
    currentProject,
    folder: currentProject?.root ?? "",
    policy: currentTask?.executionPolicy ?? state.draftPolicy,
    model: currentTask?.model ?? state.draftModel,
    prompt: state.prompts[promptKey(state)] ?? "",
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    runningTaskIds: new Set(Object.keys(state.activeRuns)),
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    subagents: currentTask?.subagents ?? [],
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    automatedTaskIds: new Set(state.automations.map((automation) => automation.taskId)),
    environment,
    storageError: state.storageError,
    actionError: state.actionError,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    projectsOpen: state.projectsOpen,
    recentsOpen: state.recentsOpen,
    openMenu: state.openMenu,
  };
}
