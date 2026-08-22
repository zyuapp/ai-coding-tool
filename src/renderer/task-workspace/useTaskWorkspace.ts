import { useEffect, useMemo, useRef, useState } from "react";
import { browserTarget, deriveView, dockFor, dockOwner, emptyWorkspaceState, promptKey, sideChatIds, stateFromData, terminalTarget, type WorkspaceState } from "../../application/workspace-state";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import { resolveScope, threadBusy, threadHandleOptions, threadSummaries, threadSummary, threadTranscript, threadWaitResult } from "../../application/thread-projection";
import { reduce, WORKSPACE_ERRORS, type WorkspaceEffect, type WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import type { ThreadRequest, ThreadResponse } from "../../contracts/threads";
import type { PersistedSubagent, PersistedTask, TaskStoreDelta } from "../../contracts/ipc";
import type { AutomationDraft, AutomationPatch } from "../../domain/automation";
import type { DiffRange } from "../../domain/diff";
import { terminalLineLimit } from "../../domain/terminal";
import type { SidebarMode, SidebarSection } from "../../domain/sidebar";
import type { AgentEffort, AgentModel, ExecutionPolicy, Subagent, SubagentActivity } from "../../domain/run";
import type { RunAttachment, Task, TaskDropTarget } from "../../domain/task";
import { createLocalTaskStore } from "./local-task-store";
import { resolveRunWorkspace } from "./resolve-run-workspace";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";
import type { ThemeMode } from "../../domain/theme";
import { applyTheme, systemPrefersDark } from "../theme";
import { applyTypography } from "../typography";
import { loadViewPreferences, saveViewPreferences } from "./local-view-preferences";
import { clearTerminalSearch, disposeTerminalView, onTerminalFindResults, onTerminalFocus, onTerminalResize, searchTerminalView } from "./terminal-views";

export type { ApprovalView } from "../../application/task-workspace";

/** How much page text a read returns when the caller does not say. */
const DEFAULT_PAGE_TEXT = 4_000;

/** A tool call held open until the thread it names stops working. */
type ThreadWaiter = {
  threadId: string;
  settle: (state: WorkspaceState) => void;
  timer: number;
};

type EnvironmentRefreshEffect = Extract<WorkspaceEffect, { type: "refresh-environment" }>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function initialState(store: ReturnType<typeof createLocalTaskStore>): WorkspaceState {
  const loaded = store.load();
  const stored = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(stored, { type: "preferences.loaded", preferences: loadViewPreferences() }).state;
}

function persistedTask(task: Task): PersistedTask {
  const { messages: _messages, subagents: _subagents, ...record } = task;
  return record;
}

function persistedSubagent(subagent: Subagent): PersistedSubagent {
  const { activity: _activity, ...record } = subagent;
  return record;
}

/** Only the subagents and activity items the last write did not already hold. */
function subagentDelta(before: Task | undefined, task: Task) {
  const previous = new Map((before?.subagents ?? []).map((subagent) => [subagent.id, subagent]));
  const subagents: Array<{ index: number; subagent: PersistedSubagent }> = [];
  const activity: Array<{ subagentId: string; index: number; item: SubagentActivity }> = [];
  (task.subagents ?? []).forEach((subagent, index) => {
    const stored = previous.get(subagent.id);
    if (stored === subagent) return;
    subagents.push({ index, subagent: persistedSubagent(subagent) });
    subagent.activity.forEach((item, position) => {
      if (stored?.activity[position] === item) return;
      activity.push({ subagentId: subagent.id, index: position, item });
    });
  });
  return { subagents, activity };
}

/** A side chat's thread never reaches the store, so it is filtered out on both sides of the delta. */
function persistedTasks(state: WorkspaceState | null) {
  if (!state) return [];
  const forked = sideChatIds(state);
  return state.tasks.filter((task) => !forked.has(task.id));
}

function persistenceDelta(previous: WorkspaceState | null, next: WorkspaceState): TaskStoreDelta {
  const previousTasks = new Map(persistedTasks(previous).map((task) => [task.id, task]));
  const nextTasks = persistedTasks(next);
  const nextIds = new Set(nextTasks.map((task) => task.id));
  const removedTasks = [...previousTasks.keys()].filter((id) => !nextIds.has(id));
  return {
    ...(removedTasks.length ? { removedTasks } : {}),
    tasks: nextTasks.flatMap((task) => {
      const before = previousTasks.get(task.id);
      if (before === task) return [];
      const messages = task.messages.flatMap((message, index) => before?.messages[index] === message ? [] : [{ index, message }]);
      const { subagents, activity } = subagentDelta(before, task);
      return [{
        task: persistedTask(task),
        messages,
        ...(subagents.length ? { subagents } : {}),
        ...(activity.length ? { activity } : {}),
      }];
    }),
    ...(!previous || previous.projects !== next.projects ? { projects: next.projects } : {}),
    ...(!previous || previous.worktrees !== next.worktrees ? { worktrees: next.worktrees } : {}),
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
  const threadWaiters = useRef<ThreadWaiter[]>([]);
  const environmentRefreshes = useRef(new Map<string, EnvironmentRefreshEffect | null>());

  function commit(next: WorkspaceState, persist = true) {
    const previous = stateRef.current;
    if (next === previous) return;
    stateRef.current = next;
    setState(next);
    releaseThreadWaiters(next);
    if (!persist || !persistenceReady.current || !next.writable || next.storageError) return;
    const delta = persistenceDelta(previous, next);
    if (!delta.tasks.length && !delta.removedTasks && !delta.projects && !delta.worktrees && !("lastFolder" in delta)) return;
    persistenceQueue.current = persistenceQueue.current
      .then(() => window.desktop.persistTaskStore(delta))
      .catch((error) => {
        persistenceReady.current = false;
        void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
      });
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

      case "delete-worktree":
        try {
          await window.desktop.deleteWorktree(effect.root);
          await dispatch({ type: "worktree.deleted", taskId: effect.taskId });
        } catch (error) {
          await dispatch({ type: "action.failed", message: errorMessage(error) });
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
        return reportFailure(window.desktop.openFile(effect.root, effect.path, effect.line));

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
    }
  }

  /** A thread being waited on has settled, so the waiting tool call can answer. */
  function releaseThreadWaiters(state: WorkspaceState) {
    const waiting = threadWaiters.current;
    if (!waiting.length) return;
    const settled = waiting.filter((waiter) => !threadBusy(state, waiter.threadId));
    if (!settled.length) return;
    threadWaiters.current = waiting.filter((waiter) => !settled.includes(waiter));
    for (const waiter of settled) {
      window.clearTimeout(waiter.timer);
      waiter.settle(state);
    }
  }

  /**
   * The window is the only holder of workspace state, so it answers thread requests itself: reads
   * come from the projection, and writes go through the same reducer the UI dispatches into.
   */
  async function answerThreadRequest(request: ThreadRequest): Promise<ThreadResponse> {
    const requestId = request.requestId;
    const ok = (result: unknown): ThreadResponse => ({ type: "thread.response", requestId, ok: true, result });
    const failed = (message: string): ThreadResponse => ({ type: "thread.response", requestId, ok: false, message });
    try {
      if (request.op === "list") {
        const scope = resolveScope(stateRef.current, request.taskId, request.project);
        if ("error" in scope) return failed(scope.error);
        return ok(threadSummaries(stateRef.current, {
          scope,
          ...(request.archived === undefined ? {} : { archived: request.archived }),
          ...(request.idleForMs === undefined ? {} : { idleForMs: request.idleForMs }),
          ...(request.search === undefined ? {} : { search: request.search }),
          ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        }, Date.now()));
      }
      if (request.op === "read") {
        const transcript = threadTranscript(stateRef.current, request.threadId, request.limit);
        return transcript ? ok(transcript) : failed(`No thread has the ID ${request.threadId}.`);
      }
      if (request.op === "wait") {
        const waited = threadWaitResult(stateRef.current, request.threadId, false);
        if (!waited) return failed(`No thread has the ID ${request.threadId}.`);
        if (!threadBusy(stateRef.current, request.threadId)) return ok(waited);
        return new Promise<ThreadResponse>((resolve) => {
          const waiter: ThreadWaiter = {
            threadId: request.threadId,
            settle: (state) => resolve(ok(threadWaitResult(state, request.threadId, false))),
            timer: window.setTimeout(() => {
              threadWaiters.current = threadWaiters.current.filter((item) => item !== waiter);
              resolve(ok(threadWaitResult(stateRef.current, request.threadId, true)));
            }, request.timeoutMs),
          };
          threadWaiters.current.push(waiter);
        });
      }
      if (request.op === "browser") {
        const state = stateRef.current;
        if (state.browserApproval?.taskId === request.taskId) return ok({ kind: "awaiting-approval", url: state.browserApproval.url });
        /** A run reaches its own thread's dock, whichever dock the user has on screen. */
        const dock = dockFor(state, dockOwner(state, request.taskId));
        if (request.read.op === "tabs") return ok({ kind: "tabs", tabs: dock.browserTabs });
        const tab = browserTarget(dock, request.read.tabId);
        if (!tab) return ok({ kind: "no-tab" });
        const snapshot = await window.desktop.readBrowserPage(tab.id, request.read.textLimit ?? DEFAULT_PAGE_TEXT, request.read.timeoutMs);
        return snapshot ? ok({ kind: "snapshot", snapshot }) : ok({ kind: "no-tab" });
      }
      if (request.op === "terminal") {
        const state = stateRef.current;
        const dock = dockFor(state, dockOwner(state, request.taskId));
        if (request.read.op === "terminals") return ok({ kind: "terminals", terminals: dock.terminals });
        const terminal = terminalTarget(dock, request.read.terminalId, request.taskId);
        if (!terminal) return ok({ kind: "no-terminal" });
        const text = await window.desktop.readTerminal(terminal.id, {
          lines: terminalLineLimit(request.read.lines),
          ...(request.read.match ? { match: request.read.match } : {}),
        });
        if (!text) return ok({ kind: "no-terminal" });
        const { taskId: _thread, id: _id, ...record } = terminal;
        return ok({ kind: "snapshot", snapshot: { terminalId: terminal.id, ...record, ...text } });
      }
      const { command } = request;
      const before = stateRef.current;
      /** A browser command acts on a tab rather than a thread, so it answers with the panel's own error. */
      if (command.type.startsWith("browser.")) {
        await dispatchRef.current(command);
        const acted = stateRef.current;
        return acted.actionError && acted.actionError !== before.actionError ? failed(acted.actionError) : ok({ thread: null });
      }
      if (command.taskId !== undefined && !before.tasks.some((task) => task.id === command.taskId)) {
        return failed(`No thread has the ID ${command.taskId}.`);
      }
      /** A new thread with no project named belongs where the thread that asked for it lives. */
      const callerProjectId = before.tasks.find((task) => task.id === request.taskId)?.projectId;
      const targeted = command.type === "task.send" && command.taskId === undefined && command.project === undefined && callerProjectId
        ? { ...command, project: callerProjectId }
        : command;
      const known = new Set(before.tasks.map((task) => task.id));
      await dispatchRef.current(targeted);
      const after = stateRef.current;
      const thread = command.taskId
        ? after.tasks.find((task) => task.id === command.taskId)
        : after.tasks.find((task) => !known.has(task.id));
      if (!thread && after.actionError && after.actionError !== before.actionError) return failed(after.actionError);
      return ok({ thread: thread ? threadSummary(after, thread) : null });
    } catch (error) {
      return failed(errorMessage(error));
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
        await dispatchRef.current({ type: "store.absent" });
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
    return window.desktop.onAgentEvent((event) => void dispatchRef.current("runId" in event ? { type: "run.event", event } : { type: "workflow.event", event }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    const stopListening = window.desktop.onThreadRequest((request) => {
      void answerThreadRequest(request).then((response) => window.desktop.answerThreadRequest(response));
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

  useEffect(() => {
    if (!("desktop" in window)) return;
    /** A folder the `claudex` command named arrives as an already-registered workspace. */
    return window.desktop.onOpenProject((workspace) => void dispatchRef.current({ type: "project.opened", workspace }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    /** The desktop hotkey names no thread, so a grabbed window waits in whichever composer is current. */
    return window.desktop.onWindowScreenshot((shot) => void dispatchRef.current({ type: "image.add", path: shot.path, label: shot.title ? `${shot.app} — ${shot.title}` : shot.app }));
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
      toggleProject: (projectId: string) => dispatch({ type: "view.toggle-project", projectId }),
      moveProject: (projectId: string, index: number) => dispatch({ type: "project.move", projectId, index }),
      removeProject: (projectId: string) => dispatch({ type: "project.remove", projectId }),
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
      openBrowser: (url: string, newTab = false) => dispatch({ type: "browser.open", url, ...(newTab ? { newTab } : {}) }),
      newBrowserTab: () => dispatch({ type: "browser.new-tab" }),
      selectBrowserTab: (tabId: string) => dispatch({ type: "browser.select-tab", tabId }),
      closeBrowserTab: (tabId: string) => dispatch({ type: "browser.close-tab", tabId }),
      goInBrowser: (delta: -1 | 1) => dispatch({ type: "browser.go", delta }),
      reloadBrowser: () => dispatch({ type: "browser.reload" }),
      decideBrowser: (allow: boolean) => dispatch({ type: "browser.decide", allow }),
      clearBrowserData: () => dispatch({ type: "browser.clear-data" }),
      openTerminal: () => dispatch({ type: "terminal.open" }),
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
