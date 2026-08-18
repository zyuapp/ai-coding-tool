import { useEffect, useMemo, useRef, useState } from "react";
import { deriveView, emptyWorkspaceState, stateFromData, type WorkspaceState } from "../../application/workspace-state";
import { reduce, WORKSPACE_ERRORS, type WorkspaceEffect, type WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import type { PersistedTask, TaskStoreDelta } from "../../contracts/ipc";
import type { AutomationDraft, AutomationPatch } from "../../domain/automation";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";
import type { RunAttachment, Task, TaskDropTarget } from "../../domain/task";
import { createLocalTaskStore } from "./local-task-store";
import { loadViewPreferences, saveViewPreferences } from "./local-view-preferences";

export type { ApprovalView } from "../../application/task-workspace";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function initialState(store: ReturnType<typeof createLocalTaskStore>): WorkspaceState {
  const loaded = store.load();
  const stored = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(stored, { type: "preferences.loaded", preferences: loadViewPreferences() }).state;
}

function persistedTask(task: Task): PersistedTask {
  const { messages: _messages, ...record } = task;
  return record;
}

function persistenceDelta(previous: WorkspaceState | null, next: WorkspaceState): TaskStoreDelta {
  const previousTasks = new Map(previous?.tasks.map((task) => [task.id, task]));
  const nextIds = new Set(next.tasks.map((task) => task.id));
  const removedTasks = [...previousTasks.keys()].filter((id) => !nextIds.has(id));
  return {
    ...(removedTasks.length ? { removedTasks } : {}),
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

/**
 * Holds workspace state and turns dispatched commands into state plus effects. All behaviour lives in
 * the reducer; this hook only owns React state, the effect runner, and persistence.
 */
export function useTaskWorkspace() {
  const storeRef = useRef<ReturnType<typeof createLocalTaskStore> | null>(null);
  if (!storeRef.current) storeRef.current = createLocalTaskStore();
  const [state, setState] = useState(() => initialState(storeRef.current!));
  const stateRef = useRef(state);
  const persistenceReady = useRef(false);
  const persistenceQueue = useRef(Promise.resolve());
  const dispatchRef = useRef<(input: WorkspaceInput) => Promise<void>>(null!);

  function commit(next: WorkspaceState) {
    const previous = stateRef.current;
    if (next === previous) return;
    stateRef.current = next;
    setState(next);
    if (!persistenceReady.current || !next.writable || next.storageError) return;
    const delta = persistenceDelta(previous, next);
    if (!delta.tasks.length && !delta.removedTasks && !delta.projects && !("lastFolder" in delta)) return;
    persistenceQueue.current = persistenceQueue.current
      .then(() => window.desktop.persistTaskStore(delta))
      .catch((error) => {
        persistenceReady.current = false;
        void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
      });
  }

  function dispatch(input: WorkspaceInput): Promise<void> {
    const transition = reduce(stateRef.current, input);
    commit(transition.state);
    return Promise.all(transition.effects.map(runEffect)).then(() => undefined);
  }
  dispatchRef.current = dispatch;

  async function runEffect(effect: WorkspaceEffect): Promise<void> {
    switch (effect.type) {
      case "persist-preferences":
        saveViewPreferences(effect.preferences);
        return;

      case "pick-project":
        try {
          const workspace = await window.desktop.openFolder();
          if (workspace) await dispatch({ type: "project.opened", workspace });
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
        }
        return;

      case "resolve-run-workspace":
        try {
          if (effect.workspaceId) {
            return await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: effect.workspaceId, kind: "project", root: effect.root! } });
          }
          if (!effect.picker) {
            return await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: await window.desktop.projectlessWorkspace() });
          }
          const selected = await window.desktop.openFolder();
          if (!selected) return await dispatch({ type: "run.unresolved", pendingId: effect.pendingId, message: WORKSPACE_ERRORS.reopenProject });
          if (selected.root !== effect.root) return await dispatch({ type: "run.unresolved", pendingId: effect.pendingId, message: WORKSPACE_ERRORS.sameProject });
          return await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: selected });
        } catch (error) {
          return await dispatch({ type: "run.unresolved", pendingId: effect.pendingId, message: errorMessage(error) });
        }

      case "start-run":
      case "send-run-command":
        window.desktop.send(effect.command);
        return;

      case "refresh-environment":
        try {
          const result = await window.desktop.changedFiles(effect.workspaceId);
          await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, ...(effect.taskId ? { taskId: effect.taskId } : {}), ...(effect.runId ? { runId: effect.runId } : {}), result });
        } catch (error) {
          await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, result: { status: "error", message: errorMessage(error) } });
        }
        return;

      case "suggest-title": {
        const title = await window.desktop.suggestTaskTitle(effect.text).catch(() => null);
        if (title) await dispatch({ type: "title.suggested", taskId: effect.taskId, title });
        return;
      }

      case "automation.save":
        return reportFailure(window.desktop.saveAutomation(effect.draft));

      case "automation.update":
        return reportFailure(window.desktop.updateAutomation(effect.taskId, effect.patch));

      case "automation.delete":
        return reportFailure(window.desktop.deleteAutomation(effect.taskId));

      case "automation.run-now":
        return reportFailure(window.desktop.runAutomationNow(effect.taskId).then(async (status) => {
          if (status === "busy" || status === "skipped") await dispatch({ type: "action.failed", message: WORKSPACE_ERRORS.busyAutomation });
        }));

      case "automation.ack":
        window.desktop.acknowledgeAutomation(effect.ack);
        return;
    }
  }

  async function reportFailure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  }

  useEffect(() => {
    const onFocus = () => void dispatchRef.current({ type: "view.set-focused", focused: true });
    const onBlur = () => void dispatchRef.current({ type: "view.set-focused", focused: false });
    if (typeof document !== "undefined" && !document.hasFocus()) onBlur();
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
        await dispatchRef.current({ type: "store.loaded", data });
        const backfill = persistenceDelta({ ...stateRef.current, tasks: data.tasks }, stateRef.current);
        if (backfill.tasks.length || backfill.removedTasks) await window.desktop.persistTaskStore(backfill);
      } else {
        await window.desktop.persistTaskStore(persistenceDelta(null, stateRef.current));
      }
      persistenceReady.current = true;
    }).catch((error) => {
      if (cancelled) return;
      void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => void dispatchRef.current({ type: "run.event", event }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    void window.desktop.listAutomations()
      .then((automations) => dispatchRef.current({ type: "automations.changed", automations }))
      .catch((error) => dispatchRef.current({ type: "action.failed", message: errorMessage(error) }));
    const stopWatching = window.desktop.onAutomationsChanged((automations) => void dispatchRef.current({ type: "automations.changed", automations }));
    const stopFiring = window.desktop.onAutomationFire((fire) => void dispatchRef.current({ type: "automation.fired", fire }));
    return () => {
      stopWatching();
      stopFiring();
    };
  }, []);

  const view = useMemo(() => deriveView(state), [state]);
  const currentRunId = state.currentId ? state.activeRuns[state.currentId]?.runId : undefined;

  useEffect(() => {
    void dispatchRef.current({ type: "view.refresh-environment" });
    if (!currentRunId) return;
    const timer = window.setInterval(() => void dispatchRef.current({ type: "view.refresh-environment" }), 2_000);
    return () => window.clearInterval(timer);
  }, [view.currentProject?.workspaceId, view.currentTask?.id, currentRunId]);

  return {
    ...view,
    /** The one door into the application. The named actions below are shorthand for the same commands. */
    dispatch: (command: AppCommand) => dispatchRef.current(command),
    actions: {
      newTask: (projectId?: string) => dispatch({ type: "task.new", ...(projectId ? { projectId } : {}) }),
      openFolder: () => dispatch({ type: "project.open" }),
      selectTask: (taskId: string) => dispatch({ type: "task.select", taskId }),
      archiveTask: (taskId: string) => dispatch({ type: "task.archive", taskId }),
      restoreTask: (taskId: string) => dispatch({ type: "task.restore", taskId }),
      renameTask: (taskId: string, title: string) => dispatch({ type: "task.rename", taskId, title }),
      moveTask: (taskId: string, target: TaskDropTarget) => dispatch({ type: "task.move", taskId, target }),
      toggleProject: (projectId: string) => dispatch({ type: "view.toggle-project", projectId }),
      removeProject: (projectId: string) => dispatch({ type: "project.remove", projectId }),
      setProjectsOpen: (open: boolean) => dispatch({ type: "view.set-projects-open", open }),
      setRecentsOpen: (open: boolean) => dispatch({ type: "view.set-recents-open", open }),
      setSessionPanelOpen: (open: boolean) => dispatch({ type: "view.set-session-panel-open", open }),
      setOpenMenu: (menu: string | null) => dispatch({ type: "view.set-menu", menu }),
      setPrompt: (prompt: string) => dispatch({ type: "view.set-prompt", prompt }),
      setPolicy: (policy: ExecutionPolicy) => dispatch({ type: "task.set-policy", policy }),
      setModel: (model: AgentModel) => dispatch({ type: "task.set-model", model }),
      setEffort: (effort: AgentEffort) => dispatch({ type: "task.set-effort", effort }),
      sendPrompt: (attachments: RunAttachment[] = [], steer = false) => dispatch({ type: "task.send", attachments, ...(steer ? { steer } : {}) }),
      steerQueued: (messageId: string) => dispatch({ type: "task.steer-queued", messageId }),
      dropQueued: (messageId: string) => dispatch({ type: "task.drop-queued", messageId }),
      saveAutomation: (draft: Omit<AutomationDraft, "taskId">) => dispatch({ type: "automation.save", draft }),
      updateAutomation: (patch: AutomationPatch) => dispatch({ type: "automation.update", patch }),
      deleteAutomation: () => dispatch({ type: "automation.delete" }),
      runAutomationNow: () => dispatch({ type: "automation.run-now" }),
      cancelRun: () => dispatch({ type: "run.cancel" }),
      decideApproval: (allow: boolean) => dispatch({ type: "run.decide", allow }),
      dismissComputerUseSetup: () => dispatch({ type: "view.dismiss-computer-use-setup" }),
    },
  };
}
