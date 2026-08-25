import { useEffect, useMemo, useRef, useState } from "react";
import { deriveView, emptyWorkspaceState, promptKey, stateFromData, type WorkspaceState } from "../../application/workspace-state";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import { threadHandleOptions } from "../../application/thread-projection";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import { errorMessage } from "./errors";
import { releaseThreadWaiters, type ThreadWaiter } from "./thread-requests";
import { nextMobileUpdate, noMobileView, type MobileViewHolder } from "./mobile-bridge";
import { createLocalTaskStore } from "./local-task-store";
import { showUnreadCount } from "./app-badge";
import { applyTheme } from "../theme";
import { applyTypography } from "../typography";
import { loadViewPreferences } from "./local-view-preferences";
import type { EnvironmentRefreshEffect } from "./effect-host";
import { runWorkspaceEffect } from "./workspace-effects";
import { workspaceActions } from "./workspace-actions";
import { useWorkspaceSubscriptions } from "./workspace-subscriptions";
import { drainLatestPersistence, hasPersistenceDelta, persistenceDelta, persistenceState, type PersistenceQueue } from "./workspace-persistence";

export type { ApprovalView } from "../../application/task-workspace";

function initialState(store: ReturnType<typeof createLocalTaskStore>): WorkspaceState {
  const loaded = store.load();
  const stored = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(stored, { type: "preferences.loaded", preferences: loadViewPreferences() }).state;
}

/** How often Git is read again while a run is writing in the checkout on screen. */
const RUNNING_REFRESH_MS = 2_000;

/** And while nothing runs there, which is only for changes the app itself did not make. */
const IDLE_REFRESH_MS = 15_000;

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
  const mobileView = useRef<MobileViewHolder>(noMobileView());

  async function persistLatest() {
    try {
      await drainLatestPersistence(persistence.current, window.desktop.persistTaskStore);
    } catch (error) {
      persistence.current.pending = null;
      persistenceReady.current = false;
      void dispatchRef.current({ type: "store.failed", message: errorMessage(error) });
    }
  }

  /** Every connected phone sees what the window sees, so each change costs the difference between them. */
  function publishToPhones(next: WorkspaceState) {
    if (!("desktop" in window)) return;
    const update = nextMobileUpdate(mobileView.current, next, Date.now());
    if (update) window.desktop.publishMobileView(update);
  }

  function commit(next: WorkspaceState, persist = true) {
    const previous = stateRef.current;
    if (next === previous) return;
    stateRef.current = next;
    setState(next);
    releaseThreadWaiters(threadWaiters, next);
    publishToPhones(next);
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

  function runEffect(effect: WorkspaceEffect): Promise<void> {
    return runWorkspaceEffect(effect, { dispatch, desktop: window.desktop, environmentRefreshes });
  }

  useWorkspaceSubscriptions({
    state: () => stateRef.current,
    dispatch: (input) => dispatchRef.current(input),
    waiters: threadWaiters,
    persistence,
    persistenceReady,
  });

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

  /**
   * The checkout on screen is read now, and again on a timer: quickly while a run writes in it, slowly
   * otherwise, because a terminal, an editor or another app moves Git with nothing to announce it. A
   * window nobody can see reads nothing, and gets its answer when it comes back instead.
   */
  useEffect(() => {
    void dispatchRef.current({ type: "view.refresh-environment" });
    const every = currentRunId ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void dispatchRef.current({ type: "view.refresh-environment" });
    }, every);
    return () => window.clearInterval(timer);
  }, [view.currentProject?.workspaceId, view.workspaceId, view.currentTask?.id, currentRunId]);

  return {
    ...view,
    threadHandles: threadHandlesFor(promptKey(state)),
    threadHandlesFor,
    /** The one door into the application. The named actions below are shorthand for the same commands. */
    dispatch: (command: AppCommand) => dispatchRef.current(command),
    actions: workspaceActions(dispatch),
  };
}
