import { useEffect, useMemo, useRef, useState } from "react";
import { promptWithAttachments, taskTitleFor, type RunAttachment } from "../../application/attachments";
import { backfillSortIndex, moveTask as moveTaskInList, nextSortIndex, orderTasks, type TaskDropTarget } from "../../application/task-order";
import { applyRunEvent, applyTask, automationRunLabel, automationRunPrompt, createTaskMessage, runStatusFor, withActiveRun, withRunStatus, type RunTransitionState } from "../../application/task-workspace";
import type { AutomationFire, ChangedFilesResult, PersistedTask, RunEvent, TaskStoreDelta } from "../../contracts/ipc";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation";
import { contextWindowLimit } from "../../domain/run";
import type { AgentModel, ContextWindow, ExecutionPolicy } from "../../domain/run";
import type { Project, Task, TaskAttention, TaskStoreData } from "../../domain/task";
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
  prompts: Record<string, string>;
  expandedProjects: Set<string>;
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  environment: { workspaceId: string; result: ChangedFilesResult } | null;
  computerUseSetup: boolean;
  automations: AutomationView[];
} & RunTransitionState & {
  storageError: string | null;
  actionError: string | null;
  writable: boolean;
};

export type { ApprovalView } from "../../application/task-workspace";

function now() {
  return Date.now();
}

/** A run only earns a dot when it settles on its own; cancelling is the user's own doing. */
function attentionFor(event: RunEvent): TaskAttention | null {
  if (event.type === "approval.requested") return "approval";
  if (event.type !== "run.status") return null;
  if (event.status === "succeeded") return "finished";
  if (event.status === "failed") return "failed";
  return null;
}

function withoutAttention(state: WorkspaceState, taskId: string | null): WorkspaceState {
  if (!taskId || !state.tasks.some((task) => task.id === taskId && task.attention)) return state;
  return applyTask(state, taskId, ({ attention: _seen, ...task }) => task);
}

function projectFor(state: WorkspaceState, task: Task | undefined) {
  return task?.projectId ? state.projects.find((project) => project.id === task.projectId) : undefined;
}

/** Composer drafts live per task, with one draft per project for the not-yet-created task. */
function promptKey(state: Pick<WorkspaceState, "currentId" | "draftProjectId">) {
  return state.currentId ?? `draft:${state.draftProjectId ?? ""}`;
}

function withPrompt(state: WorkspaceState, key: string, prompt: string): WorkspaceState {
  if (prompt) return { ...state, prompts: { ...state.prompts, [key]: prompt } };
  const { [key]: _cleared, ...prompts } = state.prompts;
  return { ...state, prompts };
}

function stateFromData(data: TaskStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const tasks = backfillSortIndex(data.tasks);
  const firstTask = data.tasks[0];
  const firstProject = firstTask?.projectId ?? (firstTask ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  return {
    tasks,
    projects,
    lastFolder: data.lastFolder,
    currentId: firstTask?.id ?? null,
    draftProjectId: firstProject,
    draftPolicy: firstTask?.executionPolicy ?? "confirm",
    draftModel: firstTask?.model ?? "default",
    draftContextWindow: firstTask?.contextWindow ?? "default",
    prompts: {},
    expandedProjects: new Set(firstProject ? [firstProject] : []),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    environment: null,
    computerUseSetup: false,
    automations: [],
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    storageError,
    actionError: null,
    writable: storageError === null,
  };
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
      prompts: {},
      expandedProjects: new Set(),
      projectsOpen: true,
      recentsOpen: true,
      openMenu: null,
      environment: null,
      computerUseSetup: false,
      automations: [],
      activeRuns: {},
      runStatuses: {},
      approvals: {},
      storageError: loaded.errors.join(" "),
      actionError: null,
      writable: false,
    };
  }
  return stateFromData(loaded.data);
}

function persistedTask(task: Task): PersistedTask {
  const { messages: _messages, ...record } = task;
  return record;
}

function persistenceDelta(previous: WorkspaceState | null, next: WorkspaceState): TaskStoreDelta {
  const previousTasks = new Map(previous?.tasks.map((task) => [task.id, task]));
  return {
    tasks: next.tasks.flatMap((task) => {
      const before = previousTasks.get(task.id);
      if (before === task) return [];
      const messages = task.messages.flatMap((message, index) => before?.messages[index] === message ? [] : [{ index, message }]);
      return [{ task: persistedTask(task), messages }];
    }),
    ...(!previous || previous.projects !== next.projects ? { projects: next.projects } : {}),
    ...(!previous || previous.lastFolder !== next.lastFolder ? { lastFolder: next.lastFolder } : {}),
  };
}

export function useTaskWorkspace() {
  const storeRef = useRef<ReturnType<typeof createLocalTaskStore> | null>(null);
  if (!storeRef.current) storeRef.current = createLocalTaskStore();
  const store = storeRef.current;
  const [state, setState] = useState(() => initialState(store));
  const stateRef = useRef(state);
  const runIds = useRef(new Map<string, string>());
  const submitting = useRef(new Set<string>());
  const persistenceReady = useRef(false);
  const persistenceQueue = useRef(Promise.resolve());
  const focused = useRef(typeof document === "undefined" || document.hasFocus());

  useEffect(() => {
    const onFocus = () => {
      focused.current = true;
      setStateAndRef((current) => withoutAttention(current, current.currentId));
    };
    const onBlur = () => { focused.current = false; };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.desktop.loadTaskStore().then(async (data) => {
      if (cancelled) return;
      if (data) {
        const loaded = stateFromData(data);
        stateRef.current = loaded;
        setState(loaded);
        const backfill = persistenceDelta({ ...loaded, tasks: data.tasks }, loaded);
        if (backfill.tasks.length) await window.desktop.persistTaskStore(backfill);
      } else {
        await window.desktop.persistTaskStore(persistenceDelta(null, stateRef.current));
      }
      persistenceReady.current = true;
    }).catch((error) => {
      if (cancelled) return;
      setStateAndRef((current) => ({ ...current, writable: false, storageError: error instanceof Error ? error.message : String(error) }));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => {
      const current = stateRef.current;
      const active = current.activeRuns[event.taskId];
      if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return;
      const project = projectFor(current, current.tasks.find((task) => task.id === event.taskId));
      const applied = applyRunEvent(current, event);
      const attention = attentionFor(event);
      const next = attention && !(focused.current && current.currentId === event.taskId)
        ? applyTask(applied, event.taskId, (task) => ({ ...task, attention }))
        : applied;
      setStateAndRef(event.type === "computer-use.setup-required" ? { ...next, computerUseSetup: true } : next);
      if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed") && project?.workspaceId) void refreshEnvironment(project.workspaceId, event.taskId, event.runId);
    });
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    void window.desktop.listAutomations()
      .then((automations) => setStateAndRef((current) => ({ ...current, automations })))
      .catch((error) => setStateAndRef((current) => ({ ...current, actionError: error instanceof Error ? error.message : String(error) })));
    const stopWatching = window.desktop.onAutomationsChanged((automations) => setStateAndRef((current) => ({ ...current, automations })));
    const stopFiring = window.desktop.onAutomationFire((fire) => { void runAutomation(fire); });
    return () => {
      stopWatching();
      stopFiring();
    };
  }, []);

  const currentTask = useMemo(() => state.tasks.find((task) => task.id === state.currentId), [state.tasks, state.currentId]);
  const currentProject = currentTask
    ? projectFor(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const folder = currentProject?.root ?? "";
  const policy = currentTask?.executionPolicy ?? state.draftPolicy;
  const model = currentTask?.model ?? state.draftModel;
  const contextWindow = currentTask?.contextWindow ?? state.draftContextWindow;
  const visibleTasks = useMemo(() => state.tasks.filter((task) => task.archivedAt === undefined), [state.tasks]);
  const orderedTasks = useMemo(() => orderTasks(visibleTasks), [visibleTasks]);
  const recentTasks = useMemo(() => visibleTasks.filter((task) => !task.projectId).sort((a, b) => b.updatedAt - a.updatedAt), [visibleTasks]);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const status = currentRun ? "running" : runStatusFor(state, state.currentId);
  const compacting = currentRun?.status === "compacting";
  const visibleApproval = currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] : undefined;
  const runningTaskIds = useMemo(() => new Set(Object.keys(state.activeRuns)), [state.activeRuns]);

  useEffect(() => {
    const workspaceId = currentProject?.workspaceId;
    if (!workspaceId) {
      setStateAndRef((current) => current.environment === null ? current : { ...current, environment: null });
      return;
    }
    const taskId = currentTask?.id;
    const runId = taskId ? runIds.current.get(taskId) : undefined;
    void refreshEnvironment(workspaceId, taskId, runId);
    if (!currentRun) return;
    const timer = window.setInterval(() => void refreshEnvironment(workspaceId, taskId, runId), 2_000);
    return () => window.clearInterval(timer);
  }, [currentProject?.workspaceId, currentTask?.id, currentRun?.runId]);

  function setStateAndRef(next: WorkspaceState | ((state: WorkspaceState) => WorkspaceState)) {
    const previous = stateRef.current;
    const resolved = typeof next === "function" ? next(previous) : next;
    stateRef.current = resolved;
    setState(resolved);
    if (persistenceReady.current && resolved.writable && !resolved.storageError) {
      const delta = persistenceDelta(previous, resolved);
      if (delta.tasks.length || delta.projects || "lastFolder" in delta) {
        persistenceQueue.current = persistenceQueue.current
          .then(() => window.desktop.persistTaskStore(delta))
          .catch((error) => {
            persistenceReady.current = false;
            setStateAndRef((current) => ({ ...current, writable: false, storageError: error instanceof Error ? error.message : String(error) }));
          });
      }
    }
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
    setStateAndRef((current) => ({ ...current, currentId: null, draftProjectId: projectId ?? null, actionError: null, lastFolder: project?.root ?? current.lastFolder, expandedProjects: projectId ? new Set(current.expandedProjects).add(projectId) : current.expandedProjects }));
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
    setStateAndRef((current) => withoutAttention({ ...current, currentId: taskId, draftProjectId: task?.projectId ?? null, lastFolder: project?.root ?? current.lastFolder, actionError: null }, taskId));
  }

  /** An archived task is unreachable, so its automation would tick forever with nowhere to run. */
  function retireAutomations(taskIds: Iterable<string>) {
    const scheduled = new Set(stateRef.current.automations.map((automation) => automation.taskId));
    for (const taskId of taskIds) {
      if (scheduled.has(taskId)) void changeAutomation(() => window.desktop.deleteAutomation(taskId));
    }
  }

  function archiveTask(taskId: string) {
    if (stateRef.current.activeRuns[taskId]) return;
    retireAutomations([taskId]);
    setStateAndRef((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, archivedAt: now() } : task),
      currentId: current.currentId === taskId ? null : current.currentId,
    }));
  }

  function moveTask(taskId: string, target: TaskDropTarget) {
    setStateAndRef((current) => {
      const tasks = moveTaskInList(current.tasks, taskId, target);
      if (tasks === current.tasks) return current;
      const projectId = tasks.find((task) => task.id === taskId)?.projectId;
      return {
        ...current,
        tasks,
        expandedProjects: projectId ? new Set(current.expandedProjects).add(projectId) : current.expandedProjects,
        openMenu: null,
      };
    });
  }

  function toggleProject(projectId: string) {
    setStateAndRef((current) => {
      const expandedProjects = new Set(current.expandedProjects);
      if (expandedProjects.has(projectId)) expandedProjects.delete(projectId);
      else expandedProjects.add(projectId);
      return { ...current, expandedProjects };
    });
  }

  function removeProject(projectId: string) {
    const current = stateRef.current;
    if (current.tasks.some((task) => task.projectId === projectId && current.activeRuns[task.id])) {
      setStateAndRef((state) => ({ ...state, actionError: "Stop the running tasks before removing this project." }));
      return;
    }
    retireAutomations(current.tasks.filter((task) => task.projectId === projectId).map((task) => task.id));
    setStateAndRef((current) => {
      const project = current.projects.find((item) => item.id === projectId);
      const expandedProjects = new Set(current.expandedProjects);
      expandedProjects.delete(projectId);
      return {
        ...current,
        projects: current.projects.filter((item) => item.id !== projectId),
        tasks: current.tasks.map((task) => {
          if (task.projectId !== projectId) return task;
          const { projectId: _removed, ...projectlessTask } = task;
          return task.archivedAt === undefined ? { ...projectlessTask, archivedAt: now() } : projectlessTask;
        }),
        currentId: current.tasks.find((task) => task.id === current.currentId)?.projectId === projectId ? null : current.currentId,
        draftProjectId: current.draftProjectId === projectId ? null : current.draftProjectId,
        lastFolder: project?.root === current.lastFolder ? null : current.lastFolder,
        expandedProjects,
        openMenu: null,
        actionError: null,
      };
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
      ? applyTask({ ...current, draftContextWindow: nextContextWindow }, current.currentId, (task) => ({
        ...task,
        contextWindow: nextContextWindow,
        ...(task.contextUsage ? { contextUsage: { ...task.contextUsage, limit: contextWindowLimit(nextContextWindow) } } : {}),
        updatedAt: now(),
      }))
      : { ...current, draftContextWindow: nextContextWindow });
  }

  async function sendPrompt(attachments: RunAttachment[] = []) {
    let current = stateRef.current;
    const draftKey = promptKey(current);
    const text = (current.prompts[draftKey] ?? "").trim();
    if ((!text && attachments.length === 0) || submitting.current.has(draftKey)) return;
    let task = current.tasks.find((item) => item.id === current.currentId);
    if (task && current.activeRuns[task.id]) return;
    const projectId = task?.projectId ?? current.draftProjectId;
    let project = projectId ? current.projects.find((item) => item.id === projectId) : undefined;
    if (projectId && !project) {
      setStateAndRef((state) => ({ ...state, actionError: "This task's project is unavailable. Reopen the project folder before running it." }));
      return;
    }
    submitting.current.add(draftKey);
    let workspace: WorkspaceRecord;
    try {
      if (project && !project.workspaceId) {
        const selected = await window.desktop.openFolder();
        if (!selected) {
          submitting.current.delete(draftKey);
          setStateAndRef((state) => ({ ...state, actionError: "Reopen this project folder before running a task." }));
          return;
        }
        if (selected.root !== project.root) {
          submitting.current.delete(draftKey);
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
      submitting.current.delete(draftKey);
      setStateAndRef((state) => ({ ...state, actionError: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const promptText = promptWithAttachments(text, attachments);
    if (!task) {
      task = {
        id: crypto.randomUUID(),
        title: taskTitleFor(text, attachments),
        ...(project ? { projectId: project.id } : {}),
        executionPolicy: current.draftPolicy,
        model: current.draftModel,
        contextWindow: current.draftContextWindow,
        messages: [],
        continuationStatus: "none",
        lastChangeSnapshot: { files: [], capturedAt: now() },
        sortIndex: nextSortIndex(current.tasks),
        updatedAt: now(),
      };
    }
    const runId = crypto.randomUUID();
    const messageAttachments = attachments.map((attachment) => attachment.path);
    const nextTask = { ...task, messages: [...task.messages, createTaskMessage("user", text, undefined, messageAttachments)], updatedAt: now() };
    const nextTasks = current.tasks.some((item) => item.id === task!.id) ? current.tasks.map((item) => item.id === task!.id ? nextTask : item) : [nextTask, ...current.tasks];
    const started = withRunStatus(
      withActiveRun({ ...current, tasks: nextTasks, currentId: task.id, actionError: null }, task.id, { taskId: task.id, runId, sequence: 0, status: "running" }),
      task.id,
      "running",
    );
    runIds.current.set(task.id, runId);
    setStateAndRef(withPrompt(started, draftKey, ""));
    submitting.current.delete(draftKey);
    window.desktop.send({ type: "start", channel: "main", taskId: task.id, runId, prompt: promptText, workspaceId: workspace.id, policy: task.executionPolicy, model: task.model ?? "default", contextWindow: task.contextWindow ?? "default", ...(task.continuation ? { continuation: task.continuation } : {}) });
  }

  /** The scheduler owns the cadence; the renderer decides whether this tick can actually run. */
  async function runAutomation(fire: AutomationFire) {
    const decline = () => window.desktop.acknowledgeAutomation({ automationId: fire.automationId, runId: fire.runId, started: false });
    const current = stateRef.current;
    const task = current.tasks.find((item) => item.id === fire.taskId);
    if (!task || task.archivedAt !== undefined || current.activeRuns[fire.taskId]) return decline();
    const project = projectFor(current, task);
    if (task.projectId && !project?.workspaceId) return decline();
    let workspace: WorkspaceRecord;
    try {
      workspace = project?.workspaceId
        ? { id: project.workspaceId, kind: "project", root: project.root }
        : await window.desktop.projectlessWorkspace();
    } catch {
      return decline();
    }
    const latest = stateRef.current;
    const target = latest.tasks.find((item) => item.id === fire.taskId);
    if (!target || target.archivedAt !== undefined || latest.activeRuns[fire.taskId]) return decline();
    const message = createTaskMessage("user", fire.prompt, automationRunLabel(fire.runNumber));
    const started = withRunStatus(
      withActiveRun(
        applyTask({ ...latest, actionError: null }, fire.taskId, (item) => ({ ...item, messages: [...item.messages, message], updatedAt: now() })),
        fire.taskId,
        { taskId: fire.taskId, runId: fire.runId, sequence: 0, status: "running" },
      ),
      fire.taskId,
      "running",
    );
    runIds.current.set(fire.taskId, fire.runId);
    setStateAndRef(started);
    window.desktop.send({
      type: "start",
      channel: "main",
      taskId: fire.taskId,
      runId: fire.runId,
      prompt: automationRunPrompt(fire.prompt, fire.runNumber),
      workspaceId: workspace.id,
      policy: fire.policy ?? target.executionPolicy,
      model: target.model ?? "default",
      contextWindow: target.contextWindow ?? "default",
      ...(target.continuation ? { continuation: target.continuation } : {}),
    });
    window.desktop.acknowledgeAutomation({ automationId: fire.automationId, runId: fire.runId, started: true });
  }

  async function changeAutomation<T>(work: () => Promise<T>) {
    try {
      await work();
    } catch (error) {
      setStateAndRef((current) => ({ ...current, actionError: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function saveAutomation(draft: Omit<AutomationDraft, "taskId">) {
    const taskId = stateRef.current.currentId;
    if (!taskId) return;
    await changeAutomation(() => window.desktop.saveAutomation({ ...draft, taskId }));
  }

  async function updateAutomation(patch: AutomationPatch) {
    const taskId = stateRef.current.currentId;
    if (!taskId) return;
    await changeAutomation(() => window.desktop.updateAutomation(taskId, patch));
  }

  async function deleteAutomation() {
    const taskId = stateRef.current.currentId;
    if (!taskId) return;
    await changeAutomation(() => window.desktop.deleteAutomation(taskId));
  }

  async function runAutomationNow() {
    const taskId = stateRef.current.currentId;
    if (!taskId) return;
    await changeAutomation(async () => {
      const status = await window.desktop.runAutomationNow(taskId);
      if (status === "busy" || status === "skipped") {
        setStateAndRef((current) => ({ ...current, actionError: "This task is already running. The automation will run on its next tick." }));
      }
    });
  }

  function cancelRun() {
    const current = stateRef.current;
    const active = current.currentId ? current.activeRuns[current.currentId] : undefined;
    if (!active) return;
    window.desktop.send({ type: "cancel", taskId: active.taskId, runId: active.runId });
  }

  function decideApproval(allow: boolean) {
    const current = stateRef.current;
    const active = current.currentId ? current.activeRuns[current.currentId] : undefined;
    const approval = active ? current.approvals[active.runId] : undefined;
    if (!active || !approval) return;
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
    prompt: state.prompts[promptKey(state)] ?? "",
    status,
    compacting,
    runActive: Boolean(currentRun),
    runningTaskIds,
    approval: visibleApproval,
    subagents: currentTask?.subagents ?? [],
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    environment: currentProject?.workspaceId && state.environment?.workspaceId === currentProject.workspaceId ? state.environment.result : null,
    storageError: state.storageError,
    actionError: state.actionError,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    projectsOpen: state.projectsOpen,
    recentsOpen: state.recentsOpen,
    openMenu: state.openMenu,
    actions: {
      newTask,
      openFolder,
      selectTask,
      archiveTask,
      moveTask,
      toggleProject,
      removeProject,
      setProjectsOpen: (open: boolean) => setStateAndRef((current) => ({ ...current, projectsOpen: open })),
      setRecentsOpen: (open: boolean) => setStateAndRef((current) => ({ ...current, recentsOpen: open })),
      setOpenMenu: (menu: string | null) => setStateAndRef((current) => ({ ...current, openMenu: menu })),
      setPrompt: (prompt: string) => setStateAndRef((current) => withPrompt(current, promptKey(current), prompt)),
      setPolicy,
      setModel,
      setContextWindow,
      sendPrompt,
      saveAutomation,
      updateAutomation,
      deleteAutomation,
      runAutomationNow,
      cancelRun,
      decideApproval,
      dismissComputerUseSetup: () => setStateAndRef((current) => ({ ...current, computerUseSetup: false })),
    },
  };
}
