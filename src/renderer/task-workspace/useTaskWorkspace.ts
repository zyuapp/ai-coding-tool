import { useEffect, useMemo, useRef, useState } from "react";
import { applyRunEvent, applyTask, createTaskMessage, type RunTransitionState } from "../../application/task-workspace";
import type { ChangedFilesResult, RunEvent } from "../../contracts/ipc";
import type { AgentModel, ContextWindow, ExecutionPolicy } from "../../domain/run";
import type { Project, Task, TaskStoreData } from "../../domain/task";
import { legacyProjectId } from "../../domain/task";
import type { WorkspaceRecord } from "../../domain/workspace";
import { createLocalTaskStore } from "./local-task-store";

type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
  lastFolder: string | null;
  currentId: string | null;
  draftProjectId: string | null;
  draftPolicy: ExecutionPolicy;
  draftModel: AgentModel;
  draftContextWindow: ContextWindow;
  prompt: string;
  expandedProjects: Set<string>;
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  environment: { workspaceId: string; result: ChangedFilesResult } | null;
} & RunTransitionState & {
  storageError: string | null;
  actionError: string | null;
  writable: boolean;
};

export type { ApprovalView } from "../../application/task-workspace";

function now() {
  return Date.now();
}

function projectFor(state: WorkspaceState, task: Task | undefined) {
  return task?.projectId ? state.projects.find((project) => project.id === task.projectId) : undefined;
}

function initialState(store: ReturnType<typeof createLocalTaskStore>): WorkspaceState {
  const loaded = store.load();
  if (!loaded.ok) {
    return {
      tasks: [],
      projects: [],
      lastFolder: null,
      currentId: null,
      draftProjectId: null,
      draftPolicy: "confirm",
      draftModel: "default",
      draftContextWindow: "default",
      prompt: "",
      expandedProjects: new Set(),
      projectsOpen: true,
      recentsOpen: true,
      openMenu: null,
      environment: null,
      activeRun: null,
      lastRunStatus: "idle",
      lastRunTaskId: null,
      approvals: {},
      subagents: {},
      storageError: loaded.errors.join(" "),
      actionError: null,
      writable: false,
    };
  }
  const projects = loaded.data.lastFolder && !loaded.data.projects.some((project) => project.root === loaded.data.lastFolder)
    ? [...loaded.data.projects, { id: legacyProjectId(loaded.data.lastFolder), root: loaded.data.lastFolder }]
    : loaded.data.projects;
  const firstTask = loaded.data.tasks[0];
  const firstProject = firstTask?.projectId ?? (firstTask ? null : projects.find((project) => project.root === loaded.data.lastFolder)?.id ?? null);
  return {
    tasks: loaded.data.tasks,
    projects,
    lastFolder: loaded.data.lastFolder,
    currentId: firstTask?.id ?? null,
    draftProjectId: firstProject,
    draftPolicy: firstTask?.executionPolicy ?? "confirm",
    draftModel: firstTask?.model ?? "default",
    draftContextWindow: firstTask?.contextWindow ?? "default",
    prompt: "",
    expandedProjects: new Set(firstProject ? [firstProject] : []),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    environment: null,
    activeRun: null,
    lastRunStatus: "idle",
    lastRunTaskId: null,
    approvals: {},
    subagents: {},
    storageError: null,
    actionError: null,
    writable: true,
  };
}

export function useTaskWorkspace() {
  const storeRef = useRef<ReturnType<typeof createLocalTaskStore> | null>(null);
  if (!storeRef.current) storeRef.current = createLocalTaskStore();
  const store = storeRef.current;
  const [state, setState] = useState(() => initialState(store));
  const stateRef = useRef(state);
  const runIds = useRef(new Map<string, string>());
  const submitting = useRef(false);

  useEffect(() => {
    if (!state.writable || state.storageError) return;
    const data: TaskStoreData = { version: 2, tasks: state.tasks, projects: state.projects, lastFolder: state.lastFolder };
    const result = store.save(data);
    if (!result.ok) {
      setStateAndRef((current) => ({ ...current, writable: false, storageError: result.error ?? `Task storage ${result.reason}.` }));
    }
  }, [state.tasks, state.projects, state.lastFolder, state.storageError, state.writable, store]);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => {
      const current = stateRef.current;
      const active = current.activeRun;
      if (!active || event.taskId !== active.taskId || event.runId !== active.runId || event.sequence <= active.sequence) return;
      const project = projectFor(current, current.tasks.find((task) => task.id === event.taskId));
      const next = applyRunEvent(current, event);
      setStateAndRef(next);
      if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed") && project?.workspaceId) void refreshEnvironment(project.workspaceId, event.taskId, event.runId);
    });
  }, []);

  const currentTask = useMemo(() => state.tasks.find((task) => task.id === state.currentId), [state.tasks, state.currentId]);
  const currentProject = currentTask
    ? projectFor(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const folder = currentProject?.root ?? "";
  const policy = currentTask?.executionPolicy ?? state.draftPolicy;
  const model = currentTask?.model ?? state.draftModel;
  const contextWindow = currentTask?.contextWindow ?? state.draftContextWindow;
  const visibleTasks = state.tasks.filter((task) => task.archivedAt === undefined);
  const orderedTasks = visibleTasks.sort((a, b) => b.updatedAt - a.updatedAt);
  const recentTasks = orderedTasks.filter((task) => !task.projectId);
  const status = state.currentId && (state.activeRun?.taskId === state.currentId || state.lastRunTaskId === state.currentId) ? state.lastRunStatus : "idle";
  const compacting = state.activeRun?.taskId === state.currentId && state.activeRun.status === "compacting";
  const visibleApproval = state.activeRun?.status === "awaiting-approval" && state.approvals[state.activeRun.runId]?.taskId === state.currentId ? state.approvals[state.activeRun.runId] : undefined;

  useEffect(() => {
    const workspaceId = currentProject?.workspaceId;
    if (!workspaceId) {
      setStateAndRef((current) => current.environment === null ? current : { ...current, environment: null });
      return;
    }
    const taskId = currentTask?.id;
    const runId = taskId ? runIds.current.get(taskId) : undefined;
    void refreshEnvironment(workspaceId, taskId, runId);
    if (!state.activeRun || state.activeRun.taskId !== taskId) return;
    const timer = window.setInterval(() => void refreshEnvironment(workspaceId, taskId, runId), 2_000);
    return () => window.clearInterval(timer);
  }, [currentProject?.workspaceId, currentTask?.id, state.activeRun?.runId]);

  function setStateAndRef(next: WorkspaceState | ((state: WorkspaceState) => WorkspaceState)) {
    const resolved = typeof next === "function" ? next(stateRef.current) : next;
    stateRef.current = resolved;
    setState(resolved);
  }

  async function refreshEnvironment(workspaceId: string, taskId?: string, runId?: string) {
    try {
      const result = await window.desktop.changedFiles(workspaceId);
      if (taskId && runId && runIds.current.get(taskId) !== runId) return;
      setStateAndRef((current) => {
        let next = { ...current, environment: { workspaceId, result } };
        if (taskId && result.status === "available") {
          next = applyTask(next, taskId, (task) => ({ ...task, lastChangeSnapshot: { files: result.files, capturedAt: now() }, updatedAt: now() }));
        }
        return next;
      });
    } catch (error) {
      setStateAndRef((current) => ({
        ...current,
        environment: { workspaceId, result: { status: "error", message: error instanceof Error ? error.message : String(error) } },
      }));
    }
  }

  function newTask(projectId?: string) {
    const project = projectId ? stateRef.current.projects.find((item) => item.id === projectId) : undefined;
    setStateAndRef((current) => ({ ...current, currentId: null, draftProjectId: projectId ?? null, prompt: "", actionError: null, lastFolder: project?.root ?? current.lastFolder, expandedProjects: projectId ? new Set(current.expandedProjects).add(projectId) : current.expandedProjects }));
  }

  async function openFolder() {
    try {
      const workspace = await window.desktop.openFolder();
      if (!workspace) return;
      const id = legacyProjectId(workspace.root);
      setStateAndRef((current) => {
        const projects = current.projects.some((project) => project.id === id)
          ? current.projects.map((project) => project.id === id ? { ...project, root: workspace.root, workspaceId: workspace.id } : project)
          : [{ id, root: workspace.root, workspaceId: workspace.id }, ...current.projects];
        return { ...current, projects, currentId: null, draftProjectId: id, lastFolder: workspace.root, actionError: null, expandedProjects: new Set(current.expandedProjects).add(id) };
      });
    } catch (error) {
      setStateAndRef((current) => ({ ...current, actionError: error instanceof Error ? error.message : String(error) }));
    }
  }

  function selectTask(taskId: string) {
    const task = stateRef.current.tasks.find((item) => item.id === taskId);
    const project = projectFor(stateRef.current, task);
    setStateAndRef((current) => ({ ...current, currentId: taskId, draftProjectId: task?.projectId ?? null, lastFolder: project?.root ?? current.lastFolder, actionError: null }));
  }

  function archiveTask(taskId: string) {
    if (stateRef.current.activeRun?.taskId === taskId) return;
    setStateAndRef((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, archivedAt: now() } : task),
      currentId: current.currentId === taskId ? null : current.currentId,
    }));
  }

  function toggleProject(projectId: string) {
    setStateAndRef((current) => {
      const expandedProjects = new Set(current.expandedProjects);
      if (expandedProjects.has(projectId)) expandedProjects.delete(projectId);
      else expandedProjects.add(projectId);
      return { ...current, expandedProjects };
    });
  }

  function setPolicy(nextPolicy: ExecutionPolicy) {
    setStateAndRef((current) => current.currentId
      ? applyTask({ ...current, draftPolicy: nextPolicy }, current.currentId, (task) => ({ ...task, executionPolicy: nextPolicy, updatedAt: now() }))
      : { ...current, draftPolicy: nextPolicy });
  }

  function setModel(nextModel: AgentModel) {
    setStateAndRef((current) => current.currentId
      ? applyTask({ ...current, draftModel: nextModel }, current.currentId, (task) => ({ ...task, model: nextModel, updatedAt: now() }))
      : { ...current, draftModel: nextModel });
  }

  function setContextWindow(nextContextWindow: ContextWindow) {
    setStateAndRef((current) => current.currentId
      ? applyTask({ ...current, draftContextWindow: nextContextWindow }, current.currentId, (task) => ({ ...task, contextWindow: nextContextWindow, updatedAt: now() }))
      : { ...current, draftContextWindow: nextContextWindow });
  }

  async function sendPrompt() {
    let current = stateRef.current;
    const text = current.prompt.trim();
    if (!text || current.activeRun || submitting.current) return;
    let task = current.tasks.find((item) => item.id === current.currentId);
    const projectId = task?.projectId ?? current.draftProjectId;
    let project = projectId ? current.projects.find((item) => item.id === projectId) : undefined;
    if (projectId && !project) {
      setStateAndRef((state) => ({ ...state, actionError: "This task's project is unavailable. Reopen the project folder before running it." }));
      return;
    }
    submitting.current = true;
    let workspace: WorkspaceRecord;
    try {
      if (project && !project.workspaceId) {
        const selected = await window.desktop.openFolder();
        if (!selected) {
          submitting.current = false;
          setStateAndRef((state) => ({ ...state, actionError: "Reopen this project folder before running a task." }));
          return;
        }
        if (selected.root !== project.root) {
          submitting.current = false;
          setStateAndRef((state) => ({ ...state, actionError: "Choose the same project folder to continue this task." }));
          return;
        }
        workspace = selected;
        setStateAndRef((state) => ({
          ...state,
          projects: state.projects.map((item) => item.id === project!.id ? { ...item, workspaceId: selected.id, root: selected.root } : item),
          actionError: null,
        }));
        current = stateRef.current;
        project = current.projects.find((item) => item.id === project!.id) ?? { ...project, workspaceId: selected.id, root: selected.root };
      } else {
        workspace = project?.workspaceId ? { id: project.workspaceId, kind: "project", root: project.root } : await window.desktop.projectlessWorkspace();
      }
    } catch (error) {
      submitting.current = false;
      setStateAndRef((state) => ({ ...state, actionError: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (!task) {
      task = {
        id: crypto.randomUUID(),
        title: text.length > 52 ? `${text.slice(0, 49)}…` : text,
        ...(project ? { projectId: project.id } : {}),
        executionPolicy: current.draftPolicy,
        model: current.draftModel,
        contextWindow: current.draftContextWindow,
        messages: [],
        continuationStatus: "none",
        lastChangeSnapshot: { files: [], capturedAt: now() },
        updatedAt: now(),
      };
    }
    const runId = crypto.randomUUID();
    const nextTask = { ...task, messages: [...task.messages, createTaskMessage("user", text)], updatedAt: now() };
    const nextTasks = current.tasks.some((item) => item.id === task!.id) ? current.tasks.map((item) => item.id === task!.id ? nextTask : item) : [nextTask, ...current.tasks];
    const nextState: WorkspaceState = { ...current, tasks: nextTasks, currentId: task.id, prompt: "", activeRun: { taskId: task.id, runId, sequence: 0, status: "running" }, lastRunStatus: "running", lastRunTaskId: task.id, subagents: { ...current.subagents, [task.id]: [] }, actionError: null };
    runIds.current.set(task.id, runId);
    setStateAndRef(nextState);
    submitting.current = false;
    window.desktop.send({ type: "start", taskId: task.id, runId, prompt: text, workspaceId: workspace.id, policy: task.executionPolicy, model: task.model ?? "default", contextWindow: task.contextWindow ?? "default", ...(task.continuation ? { continuation: task.continuation } : {}) });
  }

  function cancelRun() {
    const active = stateRef.current.activeRun;
    if (!active) return;
    window.desktop.send({ type: "cancel", taskId: active.taskId, runId: active.runId });
  }

  function decideApproval(allow: boolean) {
    const current = stateRef.current;
    const active = current.activeRun;
    const approval = active ? current.approvals[active.runId] : undefined;
    if (!active || !approval || approval.taskId !== current.currentId) return;
    window.desktop.send({ type: "approval", taskId: active.taskId, runId: active.runId, approvalId: approval.approvalId, allow });
    const { [active.runId]: _removed, ...approvals } = current.approvals;
    setStateAndRef((state) => ({ ...state, approvals }));
  }

  return {
    tasks: state.tasks,
    projects: state.projects,
    orderedTasks,
    recentTasks,
    currentTask,
    currentProject,
    folder,
    policy,
    model,
    contextWindow,
    prompt: state.prompt,
    status,
    compacting,
    globalStatus: state.lastRunStatus,
    runActive: Boolean(state.activeRun),
    runningTaskId: state.activeRun?.taskId ?? null,
    approval: visibleApproval,
    subagents: currentTask ? state.subagents[currentTask.id] ?? [] : [],
    environment: currentProject?.workspaceId && state.environment?.workspaceId === currentProject.workspaceId ? state.environment.result : null,
    storageError: state.storageError,
    actionError: state.actionError,
    expandedProjects: state.expandedProjects,
    projectsOpen: state.projectsOpen,
    recentsOpen: state.recentsOpen,
    openMenu: state.openMenu,
    actions: {
      newTask,
      openFolder,
      selectTask,
      archiveTask,
      toggleProject,
      setProjectsOpen: (open: boolean) => setStateAndRef((current) => ({ ...current, projectsOpen: open })),
      setRecentsOpen: (open: boolean) => setStateAndRef((current) => ({ ...current, recentsOpen: open })),
      setOpenMenu: (menu: string | null) => setStateAndRef((current) => ({ ...current, openMenu: menu })),
      setPrompt: (prompt: string) => setStateAndRef((current) => ({ ...current, prompt })),
      setPolicy,
      setModel,
      setContextWindow,
      sendPrompt,
      cancelRun,
      decideApproval,
    },
  };
}
