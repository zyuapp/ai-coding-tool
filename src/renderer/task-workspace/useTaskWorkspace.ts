import { useEffect, useMemo, useRef, useState } from "react";
import { deriveView, emptyWorkspaceState, promptKey, stateFromData, type WorkspaceState } from "../../application/workspace-state";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import { threadHandleOptions } from "../../application/thread-projection";
import { reduce, WORKSPACE_ERRORS, type WorkspaceEffect, type WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import type { AgentEvent } from "../../contracts/ipc";
import type { AutomationDraft, AutomationPatch } from "../../domain/automation";
import type { DiffRange } from "../../domain/diff";
import type { SidebarMode, SidebarSection } from "../../domain/sidebar";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";
import type { RunAttachment, TaskDropTarget } from "../../domain/task";
import { subscribeToDesktop } from "./desktop-subscriptions";
import { errorMessage } from "./errors";
import { answerThreadRequest, releaseThreadWaiters, type ThreadRequestHost, type ThreadWaiter } from "./thread-requests";
import { createLocalTaskStore } from "./local-task-store";
import { resolveRunWorkspace } from "./resolve-run-workspace";
import { displayShortcut } from "../../domain/shortcuts";
import { showUnreadCount } from "./app-badge";
import { MAC } from "../platform";
import type { ThemeMode } from "../../domain/theme";
import { applyTheme, systemPrefersDark } from "../theme";
import { applyTypography } from "../typography";
import { loadViewPreferences, saveViewPreferences } from "./local-view-preferences";
import { clearTerminalSearch, disposeTerminalView, onTerminalFindResults, onTerminalFocus, onTerminalResize, searchTerminalView } from "./terminal-views";
import { drainLatestPersistence, hasPersistenceDelta, persistenceDelta, persistenceState, storeBackfill, type PersistenceQueue } from "./workspace-persistence";

export type { ApprovalView } from "../../application/task-workspace";

type EnvironmentRefreshEffect = Extract<WorkspaceEffect, { type: "refresh-environment" }>;

/** Which channel the event arrived on: a run's own, or the thread's, which outlives every run. */
function agentEventInput(event: AgentEvent): WorkspaceInput {
  return "runId" in event ? { type: "run.event", event } : { type: "thread.event", event };
}

function initialState(store: ReturnType<typeof createLocalTaskStore>): WorkspaceState {
  const loaded = store.load();
  const stored = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(stored, { type: "preferences.loaded", preferences: loadViewPreferences() }).state;
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
  const persistence = useRef<PersistenceQueue>({ persisted: null, pending: null, inFlight: false });
  const dispatchRef = useRef<(input: WorkspaceInput) => Promise<void>>(null!);
  const threadWaiters = useRef<ThreadWaiter[]>([]);
  const environmentRefreshes = useRef(new Map<string, EnvironmentRefreshEffect | null>());

  async function persistLatest() {
    try {
      await drainLatestPersistence(persistence.current, window.desktop.persistTaskStore);
    } catch (error) {
      persistence.current.pending = null;
      persistenceReady.current = false;
      void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
    }
  }

  function commit(next: WorkspaceState, persist = true) {
    const previous = stateRef.current;
    if (next === previous) return;
    stateRef.current = next;
    setState(next);
    releaseThreadWaiters(threadWaiters, next);
    if (!persist || !persistenceReady.current || !next.writable || next.storageError) return;
    const snapshot = persistenceState(next);
    const delta = persistenceDelta(persistenceState(previous), snapshot);
    if (!hasPersistenceDelta(delta)) return;
    persistence.current.pending = snapshot;
    void persistLatest();
  }

  function dispatch(input: WorkspaceInput): Promise<void> {
    const transition = reduce(stateRef.current, input);
    commit(transition.state, input.type !== "subagent.activity.loaded");
    return Promise.all(transition.effects.map(runEffect)).then(() => undefined);
  }
  dispatchRef.current = dispatch;

  /** One Git scan per checkout. A tick during a slow scan replaces the one follow-up still needed. */
  async function refreshEnvironment(first: EnvironmentRefreshEffect) {
    if (environmentRefreshes.current.has(first.workspaceId)) {
      environmentRefreshes.current.set(first.workspaceId, first);
      return;
    }
    environmentRefreshes.current.set(first.workspaceId, null);
    let effect: EnvironmentRefreshEffect | null = first;
    try {
      while (effect) {
        try {
          const result = await window.desktop.changedFiles(effect.workspaceId);
          await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, ...(effect.taskId ? { taskId: effect.taskId } : {}), ...(effect.runId ? { runId: effect.runId } : {}), result });
        } catch (error) {
          await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, result: { status: "error", message: errorMessage(error) } });
        }
        effect = environmentRefreshes.current.get(first.workspaceId) ?? null;
        environmentRefreshes.current.set(first.workspaceId, null);
      }
    } finally {
      environmentRefreshes.current.delete(first.workspaceId);
    }
  }

  async function runEffect(effect: WorkspaceEffect): Promise<void> {
    switch (effect.type) {
      case "persist-preferences":
        saveViewPreferences(effect.preferences);
        return;

      case "load-subagent-activity":
        try {
          const activity = await window.desktop.loadSubagentActivity(effect.taskId, effect.subagentId);
          if (activity.length) await dispatch({ type: "subagent.activity.loaded", taskId: effect.taskId, subagentId: effect.subagentId, activity });
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
        }
        return;

      case "pick-project":
        try {
          const workspace = await window.desktop.openFolder();
          if (workspace) await dispatch({ type: "project.opened", workspace });
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
        }
        return;

      case "register-project":
        try {
          const workspace = await window.desktop.registerProject(effect.root);
          await dispatch({ type: "project.registered", projectId: effect.projectId, workspace });
        } catch (error) {
          await dispatch({ type: "project.register-failed", projectId: effect.projectId, message: errorMessage(error) });
        }
        return;

      case "resolve-run-workspace":
        return await dispatch(await resolveRunWorkspace(effect, window.desktop));

      case "start-run":
      case "send-run-command":
        window.desktop.send(effect.command);
        return;

      case "create-worktree":
        try {
          const worktree = await window.desktop.createWorktree({ projectRoot: effect.projectRoot, carryChanges: true });
          await dispatch({ type: "worktree.created", taskId: effect.taskId, worktree });
        } catch (error) {
          await dispatch({ type: "worktree.failed", taskId: effect.taskId, message: `Could not create the worktree: ${errorMessage(error)}` });
        }
        return;

      case "release-worktree":
        try {
          const snapshot = await window.desktop.releaseWorktree({
            worktreeId: effect.worktreeId,
            root: effect.root,
            taskId: effect.taskId,
            title: effect.title,
            release: "returned-to-local",
          });
          await dispatch({ type: "worktree.released", taskId: effect.taskId, snapshot });
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
        }
        return;

      case "list-worktrees":
        try {
          await dispatch({ type: "worktrees.loaded", worktrees: await window.desktop.listManagedWorktrees() });
        } catch (error) {
          await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
        }
        return;

      case "reveal-worktree":
        try {
          await window.desktop.revealWorktree(effect.root);
        } catch (error) {
          await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
        }
        return;

      case "delete-worktree":
        try {
          const snapshot = await window.desktop.releaseWorktree({
            worktreeId: effect.worktreeId,
            root: effect.root,
            taskId: null,
            title: effect.title,
            release: "deleted",
          });
          await dispatch({ type: "worktree.deleted", worktreeId: effect.worktreeId, root: effect.root, snapshot });
        } catch (error) {
          await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
        }
        return;

      case "refresh-environment":
        return refreshEnvironment(effect);

      case "read-diff":
        try {
          const result = await window.desktop.diffSummary(effect.workspaceId, effect.range);
          await dispatch({ type: "diff.loaded", owner: effect.owner, workspaceId: effect.workspaceId, range: effect.range, result });
        } catch (error) {
          await dispatch({
            type: "diff.loaded",
            owner: effect.owner,
            workspaceId: effect.workspaceId,
            range: effect.range,
            result: { status: "error", message: errorMessage(error) },
          });
        }
        return;

      case "checkout-branch":
        try {
          if (effect.create) await window.desktop.createBranch(effect.workspaceId, effect.branch);
          await window.desktop.checkoutBranch(effect.workspaceId, effect.branch);
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
        }
        await dispatch({ type: "view.refresh-environment" });
        return;

      case "suggest-title": {
        const title = await window.desktop.suggestTaskTitle(effect.text, effect.attachments).catch(() => null);
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

      case "file.open":
        return reportFailure(window.desktop.openFile(effect.roots, effect.path, effect.line));

      case "app.open-folder":
        return reportFailure(window.desktop.openFolderInApp(effect.appId, effect.root));

      case "browser.open":
        return reportFailure(window.desktop.openBrowserTab(effect.tabId, effect.url));

      case "browser.navigate":
        return reportFailure(window.desktop.navigateBrowser(effect.tabId, effect.url));

      case "browser.history":
        return reportFailure(window.desktop.browserHistory(effect.tabId, effect.delta));

      case "browser.reload":
        return reportFailure(window.desktop.reloadBrowser(effect.tabId));

      case "browser.close":
        return reportFailure(window.desktop.closeBrowserTab(effect.tabId));

      case "browser.show":
        return reportFailure(window.desktop.showBrowserTab(effect.tabId));

      case "browser.act":
        return reportFailure(window.desktop.actInBrowser(effect.tabId, effect.action));

      case "browser.clear-data":
        return reportFailure(window.desktop.clearBrowserData());

      case "terminal.start":
        return reportFailure(window.desktop.startTerminal(effect.terminalId, { cwd: effect.cwd }));

      case "terminal.write":
        return reportFailure(window.desktop.writeTerminal(effect.terminalId, effect.data));

      case "terminal.resize":
        return reportFailure(window.desktop.resizeTerminal(effect.terminalId, effect.cols, effect.rows));

      /** The view outlives the panel, so the shell going is the only thing that takes it away. */
      case "terminal.close":
        disposeTerminalView(effect.terminalId);
        return reportFailure(window.desktop.closeTerminal(effect.terminalId));

      case "find-in-page":
        return reportFailure(window.desktop.findInPage(effect.tabId, effect.query, effect.forward, effect.findNext));

      case "stop-find-in-page":
        return reportFailure(window.desktop.stopFindInPage(effect.tabId));

      case "focus-browser":
        return reportFailure(window.desktop.focusBrowserTab(effect.tabId));

      case "find-in-terminal":
        searchTerminalView(effect.terminalId, effect.query, effect.forward);
        return;

      case "stop-find-in-terminal":
        clearTerminalSearch(effect.terminalId);
        return;

      case "focus-window":
        window.desktop.focusWindow();
        return;

      case "close-window":
        window.desktop.closeWindow();
        return;

      case "apply-shortcuts":
        window.desktop.setShortcuts(effect.overrides);
        return;

      case "apply-capture-options":
        window.desktop.setCaptureOptions(effect.options);
        return;

      case "capture-shortcut":
        window.desktop.setShortcutCapture(effect.capturing);
        return;

      case "announce-thread":
        window.desktop.announceThread(effect.notice);
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
        const current = persistenceState(stateRef.current);
        const backfill = storeBackfill(data, current);
        if (hasPersistenceDelta(backfill)) await window.desktop.persistTaskStore(backfill);
      } else {
        await dispatchRef.current({ type: "store.absent" });
        await window.desktop.persistTaskStore(persistenceDelta(null, persistenceState(stateRef.current)));
      }
      persistence.current.persisted = persistenceState(stateRef.current);
      persistenceReady.current = true;
    }).catch((error) => {
      if (cancelled) return;
      void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => void dispatchRef.current(agentEventInput(event)));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    const host: ThreadRequestHost = { state: () => stateRef.current, dispatch: (input) => dispatchRef.current(input), waiters: threadWaiters };
    const stopListening = window.desktop.onThreadRequest((request) => {
      void answerThreadRequest(host, request).then((response) => window.desktop.answerThreadRequest(response));
    });
    return () => {
      stopListening();
      for (const waiter of threadWaiters.current) window.clearTimeout(waiter.timer);
      threadWaiters.current = [];
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserEvent((page) => void dispatchRef.current({ type: "browser.updated", page }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onTerminalEvent((update) => void dispatchRef.current({ type: "terminal.updated", update }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserFind(({ tabId, matches, index }) => void dispatchRef.current({
      type: "find.results",
      target: { kind: "browser", tabId },
      results: { matches, index },
    }));
  }, []);

  useEffect(() => {
    const stopReporting = onTerminalFindResults((terminalId, results) => void dispatchRef.current({ type: "find.results", target: { kind: "terminal", terminalId }, results }));
    const stopWatching = onTerminalFocus((terminalId) => void dispatchRef.current({ type: "terminal.focus", terminalId }));
    const stopSizing = onTerminalResize((terminalId, cols, rows) => void dispatchRef.current({ type: "terminal.resize", terminalId, cols, rows }));
    return () => {
      stopReporting();
      stopWatching();
      stopSizing();
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    /** Preferences are read before the first render, so the bindings they hold reach main from here. */
    window.desktop.setShortcuts(stateRef.current.shortcuts);
    window.desktop.setCaptureOptions({ sound: stateRef.current.captureSound, focus: stateRef.current.captureFocus });
    const stopListening = window.desktop.onShortcut(({ action, surface }) => void dispatchRef.current({ type: "view.shortcut", action, surface }));
    const stopCapturing = window.desktop.onShortcutCaptured((binding) => void dispatchRef.current({ type: "shortcut.captured", binding }));
    const stopRefusals = window.desktop.onDesktopShortcutRefused((binding) => void dispatchRef.current({
      type: "action.failed",
      message: `${displayShortcut(binding, MAC)} belongs to another app, so grabbing a window has no shortcut.`,
    }));
    return () => {
      stopListening();
      stopCapturing();
      stopRefusals();
    };
  }, []);

  /** The two side buttons on a mouse mean what the back and forward keystrokes mean. */
  useEffect(() => {
    function navigate(event: MouseEvent) {
      if (event.button !== 3 && event.button !== 4) return;
      /** Chromium walks its own session history on the press, which would take the window off the app. */
      event.preventDefault();
      if (event.type !== "mouseup") return;
      void dispatchRef.current({ type: "view.shortcut", action: event.button === 3 ? "nav.back" : "nav.forward", surface: "any" });
    }
    window.addEventListener("mousedown", navigate);
    window.addEventListener("mouseup", navigate);
    return () => {
      window.removeEventListener("mousedown", navigate);
      window.removeEventListener("mouseup", navigate);
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return subscribeToDesktop((input) => void dispatchRef.current(input));
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

  /** The `@` menu's threads, per draft, since which threads are in scope depends on the draft. */
  const threadHandlesFor = useMemo(() => {
    const cached = new Map<string, ThreadHandleOption[]>();
    return (draftKey: string) => {
      const known = cached.get(draftKey);
      if (known) return known;
      const options = threadHandleOptions(state, draftKey);
      cached.set(draftKey, options);
      return options;
    };
  }, [state]);

  useEffect(() => { applyTheme(view.theme, view.themeMode === "auto"); }, [view.theme, view.themeMode]);

  /**
   * Only a window set to "auto" reads the system's appearance, and it can only read it truthfully
   * once the platform has stopped being told which ground to use — so it re-reads after applying.
   */
  useEffect(() => {
    if (view.themeMode !== "auto") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const follow = () => void dispatchRef.current({ type: "view.system-scheme", dark: media.matches });
    const settle = requestAnimationFrame(follow);
    media.addEventListener("change", follow);
    return () => {
      cancelAnimationFrame(settle);
      media.removeEventListener("change", follow);
    };
  }, [view.themeMode, view.theme]);

  useEffect(() => {
    applyTypography({ uiFont: view.uiFont, monoFont: view.monoFont, readingSize: view.readingSize, terminalSize: view.terminalSize });
  }, [view.uiFont, view.monoFont, view.readingSize, view.terminalSize]);

  /** The app icon carries the same count the rows' dots do, so a switch away still shows it. */
  useEffect(() => { showUnreadCount(state.tasks); }, [state.tasks]);

  const currentRunId = state.currentId ? state.activeRuns[state.currentId]?.runId : undefined;

  useEffect(() => {
    void dispatchRef.current({ type: "view.refresh-environment" });
    if (!currentRunId) return;
    const timer = window.setInterval(() => void dispatchRef.current({ type: "view.refresh-environment" }), 2_000);
    return () => window.clearInterval(timer);
  }, [view.currentProject?.workspaceId, view.workspaceId, view.currentTask?.id, currentRunId]);

  return {
    ...view,
    threadHandles: threadHandlesFor(promptKey(state)),
    threadHandlesFor,
    /** The one door into the application. The named actions below are shorthand for the same commands. */
    dispatch: (command: AppCommand) => dispatchRef.current(command),
    actions: {
      newTask: (projectId?: string, worktreeId?: string) => dispatch({ type: "task.new", ...(projectId ? { projectId } : {}), ...(worktreeId ? { worktreeId } : {}) }),
      openFolder: () => dispatch({ type: "project.open" }),
      selectTask: (taskId: string) => dispatch({ type: "task.select", taskId }),
      archiveTask: (taskId: string) => dispatch({ type: "task.archive", taskId }),
      restoreTask: (taskId: string) => dispatch({ type: "task.restore", taskId }),
      clearArchive: () => dispatch({ type: "task.clear-archive" }),
      renameTask: (taskId: string, title: string) => dispatch({ type: "task.rename", taskId, title }),
      moveTask: (taskId: string, target: TaskDropTarget) => dispatch({ type: "task.move", taskId, target }),
      forkTask: (taskId: string, worktree = false) => dispatch({ type: "task.fork", taskId, ...(worktree ? { worktree } : {}) }),
      toggleProject: (projectId: string) => dispatch({ type: "view.toggle-project", projectId }),
      moveProject: (projectId: string, index: number) => dispatch({ type: "project.move", projectId, index }),
      removeProject: (projectId: string) => dispatch({ type: "project.remove", projectId }),
      editProject: (projectId: string, edit: { name?: string | null; root?: string }) => dispatch({ type: "project.edit", projectId, ...edit }),
      editProjectOpen: (projectId: string) => dispatch({ type: "view.edit-project", projectId }),
      editProjectClose: () => dispatch({ type: "view.edit-project", projectId: null }),
      dismissTask: (taskId: string) => dispatch({ type: "task.dismiss", taskId }),
      dismissAllTasks: () => dispatch({ type: "task.dismiss-all" }),
      setSectionOpen: (section: SidebarSection, open: boolean) => dispatch({ type: "view.set-section-open", section, open }),
      setTheme: (theme: string) => dispatch({ type: "view.set-theme", theme }),
      setThemeFamily: (family: string) => dispatch({ type: "view.set-theme-family", family, systemDark: systemPrefersDark() }),
      setThemeMode: (mode: ThemeMode) => dispatch({ type: "view.set-theme-mode", mode, systemDark: systemPrefersDark() }),
      setSystemScheme: (dark: boolean) => dispatch({ type: "view.system-scheme", dark }),
      setUiFont: (font: string) => dispatch({ type: "view.set-ui-font", font }),
      setMonoFont: (font: string) => dispatch({ type: "view.set-mono-font", font }),
      setReadingSize: (size: number) => dispatch({ type: "view.set-reading-size", size }),
      setTerminalSize: (size: number) => dispatch({ type: "view.set-terminal-size", size }),
      setSidebarMode: (mode: SidebarMode) => dispatch({ type: "view.set-sidebar-mode", mode }),
      setSessionPanelOpen: (open: boolean) => dispatch({ type: "view.set-session-panel-open", open }),
      setPlainEnglish: (enabled: boolean) => dispatch({ type: "view.set-plain-english", enabled }),
      setChromeBrowser: (enabled: boolean) => dispatch({ type: "view.set-chrome-browser", enabled }),
      setNotifications: (enabled: boolean) => dispatch({ type: "view.set-notifications", enabled }),
      setSidebarOpen: (open: boolean) => dispatch({ type: "view.set-sidebar-open", open }),
      setShortcut: (action: string, binding: string | null) => dispatch({ type: "view.set-shortcut", action, binding }),
      resetShortcuts: () => dispatch({ type: "view.reset-shortcuts" }),
      captureShortcut: (action: string | null) => dispatch({ type: "view.capture-shortcut", action }),
      inspectSubagent: (subagentId: string) => dispatch({ type: "view.inspect-subagent", subagentId }),
      setOpenMenu: (menu: string | null) => dispatch({ type: "view.set-menu", menu }),
      goBack: () => dispatch({ type: "view.go-back" }),
      goForward: () => dispatch({ type: "view.go-forward" }),
      setPrompt: (prompt: string) => dispatch({ type: "view.set-prompt", prompt }),
      setPolicy: (policy: ExecutionPolicy) => dispatch({ type: "task.set-policy", policy }),
      setModel: (model: AgentModel) => dispatch({ type: "task.set-model", model }),
      setEffort: (effort: AgentEffort) => dispatch({ type: "task.set-effort", effort }),
      setWorktree: (worktree: boolean) => dispatch({ type: "task.set-worktree", worktree }),
      setBranch: (branch: string | null, create?: boolean) => dispatch({ type: "task.set-branch", branch, ...(create ? { create } : {}) }),
      checkoutBranch: (branch: string, create?: boolean) => dispatch({ type: "task.checkout-branch", branch, ...(create ? { create } : {}) }),
      deleteWorktree: () => dispatch({ type: "worktree.delete" }),
      refreshWorktrees: () => dispatch({ type: "worktree.refresh" }),
      revealWorktree: (root: string) => dispatch({ type: "worktree.reveal", root }),
      deleteManagedWorktree: (root: string) => dispatch({ type: "worktree.delete", root }),
      sendPrompt: (attachments: RunAttachment[] = [], steer = false) => dispatch({ type: "task.send", attachments, ...(steer ? { steer } : {}) }),
      steerQueued: (messageId: string) => dispatch({ type: "task.steer-queued", messageId }),
      dropQueued: (messageId: string) => dispatch({ type: "task.drop-queued", messageId }),
      saveAutomation: (draft: Omit<AutomationDraft, "taskId">) => dispatch({ type: "automation.save", draft }),
      updateAutomation: (patch: AutomationPatch) => dispatch({ type: "automation.update", patch }),
      deleteAutomation: () => dispatch({ type: "automation.delete" }),
      runAutomationNow: () => dispatch({ type: "automation.run-now" }),
      cancelRun: () => dispatch({ type: "run.cancel" }),
      stopBackgroundProcess: (processId: string) => dispatch({ type: "run.stop-process", processId }),
      decideApproval: (allow: boolean) => dispatch({ type: "run.decide", allow }),
      dismissComputerUseSetup: () => dispatch({ type: "view.dismiss-computer-use-setup" }),
      setDockOpen: (open: boolean) => dispatch({ type: "view.set-dock-open", open }),
      setDockExpanded: (expanded: boolean) => dispatch({ type: "view.set-dock-expanded", expanded }),
      setSettingsOpen: (open: boolean) => dispatch({ type: "view.set-settings-open", open }),
      closeTab: () => dispatch({ type: "view.close-tab" }),
      openDockPanel: (panel: string) => dispatch({ type: "view.open-dock-panel", panel }),
      closeDockPanel: (panel: string) => dispatch({ type: "view.close-dock-panel", panel }),
      openWorkflow: (workflowId: string) => dispatch({ type: "view.open-workflow", workflowId }),
      selectDockTab: (tab: string) => dispatch({ type: "view.select-dock-tab", tab }),
      toggleDiff: () => dispatch({ type: "diff.toggle" }),
      refreshDiff: () => dispatch({ type: "diff.refresh" }),
      setDiffRange: (range: DiffRange) => dispatch({ type: "diff.set-range", range }),
      setDiffCollapsed: (path: string, collapsed: boolean) => dispatch({ type: "diff.set-collapsed", path, collapsed }),
      setDiffViewed: (path: string, viewed: boolean) => dispatch({ type: "diff.set-viewed", path, viewed }),
      setDiffSplit: (split: boolean) => dispatch({ type: "diff.set-split", split }),
      openBrowser: (url: string, newTab = false, tabId?: string) => dispatch({ type: "browser.open", url, ...(newTab ? { newTab } : {}), ...(tabId ? { tabId } : {}) }),
      newBrowserTab: () => dispatch({ type: "browser.new-tab" }),
      selectBrowserTab: (tabId: string) => dispatch({ type: "browser.select-tab", tabId }),
      closeBrowserTab: (tabId: string) => dispatch({ type: "browser.close-tab", tabId }),
      goInBrowser: (delta: -1 | 1, tabId?: string) => dispatch({ type: "browser.go", delta, ...(tabId ? { tabId } : {}) }),
      reloadBrowser: (tabId?: string) => dispatch({ type: "browser.reload", ...(tabId ? { tabId } : {}) }),
      decideBrowser: (allow: boolean) => dispatch({ type: "browser.decide", allow }),
      clearBrowserData: () => dispatch({ type: "browser.clear-data" }),
      openTerminal: () => dispatch({ type: "terminal.open" }),
      openFolderInApp: (appId: string) => dispatch({ type: "app.open-folder", appId }),
      selectTerminal: (terminalId: string) => dispatch({ type: "terminal.select", terminalId }),
      closeTerminal: (terminalId: string) => dispatch({ type: "terminal.close", terminalId }),
      sendToTerminal: (terminalId: string, data: string) => dispatch({ type: "terminal.input", terminalId, data }),
      openFind: () => dispatch({ type: "view.find-open" }),
      setFindQuery: (query: string) => dispatch({ type: "view.find-query", query }),
      stepFind: (delta: -1 | 1) => dispatch({ type: "view.find-step", delta }),
      closeFind: () => dispatch({ type: "view.find-close" }),
      resizeTerminal: (terminalId: string, cols: number, rows: number) => dispatch({ type: "terminal.resize", terminalId, cols, rows }),
    },
  };
}
