import { emptyWorkspaceState, sideChatIds, stateFromData, type WorkspaceState } from "../../application/workspace-state";
import { unreadView } from "../../application/thread-attention";
import { reduce, type WorkspaceInput } from "../../application/workspace-reducer";
import { executeWorkspaceInput, type WorkspaceExecution } from "../../application/workspace-execution";
import { createLocalTaskStore, createDraftPersistence } from "./local-task-store";
import { loadViewPreferences } from "./local-view-preferences";
import { createRuntimeInputs } from "./runtime-inputs";
import { createRuntimeHistory } from "./runtime-history";
import { errorMessage } from "./errors";
import { releaseThreadWaiters, type ThreadWaiter } from "./thread-requests";
import { nextMobileUpdate, noMobileView } from "./mobile-bridge";
import type { EnvironmentRefreshEffect } from "./effect-host";
import { runWorkspaceEffect } from "./workspace-effects";
import { subscribeWorkspaceRuntime } from "./runtime-subscriptions";
import { drainLatestPersistence, hasPersistenceChanges, persistedStoreState, persistenceState, type PersistenceQueue } from "./workspace-persistence";

export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;

function initialState(): WorkspaceState {
  const loaded = createLocalTaskStore().load();
  const state = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(state, { type: "preferences.loaded", preferences: loadViewPreferences() }).state;
}

/** State, effects and durability have one lifetime, independent of React subscriptions. */
export function createWorkspaceRuntime() {
  let state = initialState();
  let persistenceReady = false;
  let started: Promise<void> | null = null;
  let subscriptions: ReturnType<typeof subscribeWorkspaceRuntime> | null = null;
  const effectsInFlight = new Set<Promise<unknown>>();
  let refreshTimer: number | undefined;
  let refreshInputs: unknown[] = [];
  let generation = 0;
  let disposed = false;
  let badgeCount = -1;
  const listeners = new Set<() => void>();
  const persistence: PersistenceQueue = { persisted: null, pending: null, inFlight: null };
  const waiters = { current: [] as ThreadWaiter[] };
  const environmentRefreshes = { current: new Map<string, EnvironmentRefreshEffect | null>() };
  const mobileView = noMobileView();
  const drafts = createDraftPersistence(() => state, dispatch);
  const history = createRuntimeHistory({ state: () => state, load: (taskId) => window.desktop.loadThreadMessages(taskId), dispatch: (input) => rawExecute(input).completed.then(() => undefined), persistence });
  const inputs = createRuntimeInputs({
    generation: () => generation,
    active: (current) => !disposed && generation === current,
    history,
    execute: rawExecute,
    track: (completed) => {
      effectsInFlight.add(completed);
      void completed.finally(() => effectsInFlight.delete(completed));
    },
  });

  function commit(next: WorkspaceState, input: WorkspaceInput) {
    if (disposed || next === state) return;
    const previous = state;
    state = next;
    if (next.prompts !== previous.prompts) drafts.changed();
    releaseThreadWaiters(waiters, next);
    if (badgeCount === -1 || next.threads !== previous.threads || next.sideChats !== previous.sideChats) {
      const forked = sideChatIds(next);
      const count = unreadView(next, next.threads.filter((thread) => !forked.has(thread.id))).unreadCount;
      if (count !== badgeCount) window.desktop.setBadgeCount(count);
      badgeCount = count;
    }
    const update = nextMobileUpdate(mobileView, next, Date.now());
    if (update) window.desktop.publishMobileView(update);
    for (const listener of listeners) listener();
    if (started) refreshEnvironment();
    if (next.currentId !== previous.currentId && next.currentId) {
      const loading = history.hydrate(next.currentId).catch((error) => rawExecute({ type: "action.failed", message: errorMessage(error) }).completed);
      effectsInFlight.add(loading);
      void loading.finally(() => effectsInFlight.delete(loading));
    }
    if (!persistenceReady || !next.writable || next.storageError || (input.type === "subagent.activity.loaded" || input.type === "store.thread-loaded")) return;
    if (!hasPersistenceChanges(persistenceState(previous), persistenceState(next))) return;
    persistence.pending = persistenceState(next);
    void drainLatestPersistence(persistence, window.desktop.persistTaskStore).catch(storageFailed);
  }

  function storageFailed(error: unknown) {
    persistenceReady = false;
    void dispatch({ type: "store.failed", message: errorMessage(error) });
  }

  function rawExecute(input: WorkspaceInput): WorkspaceExecution {
    const executionGeneration = generation;
    const execution = executeWorkspaceInput(input, {
      state: () => state,
      active: () => !disposed && generation === executionGeneration,
      commit,
      prepare: async (input) => { for (const taskId of history.needed(input)) await history.hydrate(taskId); },
      perform: (effect, dispatch) => runWorkspaceEffect(effect, { dispatch, desktop: window.desktop, environmentRefreshes }),
    });
    effectsInFlight.add(execution.completed);
    void execution.completed.finally(() => effectsInFlight.delete(execution.completed));
    return execution;
  }

  function dispatch(input: WorkspaceInput): Promise<void> {
    return inputs.execute(input).completed.then(() => undefined);
  }

  function refreshEnvironment() {
    const thread = state.threads.find((item) => item.id === state.currentId);
    const run = state.currentId ? state.activeRuns[state.currentId]?.runId : undefined;
    const inputs = [state.currentId, state.draftProjectId, thread?.worktreeId, state.projects, run];
    if (inputs.every((value, index) => value === refreshInputs[index])) return;
    refreshInputs = inputs;
    if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    void dispatch({ type: "view.refresh-environment" });
    refreshTimer = window.setInterval(() => void dispatch({ type: "view.refresh-environment" }), run ? 2_000 : 15_000);
  }

  async function initialize(currentGeneration: number) {
    try {
      const data = await window.desktop.loadTaskStore();
      if (disposed || generation !== currentGeneration) return;
      persistence.persisted = data ? persistedStoreState(data) : null;
      if (data) await dispatch({ type: "store.loaded", data, hiddenTasks: data.hiddenTasks });
      else await dispatch({ type: "store.absent" });
      await drafts.restore();
      if (state.currentId) await history.hydrate(state.currentId).catch((error) => rawExecute({ type: "action.failed", message: errorMessage(error) }).completed);
      if (disposed || generation !== currentGeneration) return;
      persistence.pending = persistenceState(state);
      persistenceReady = true;
      await drainLatestPersistence(persistence, window.desktop.persistTaskStore);
    } catch (error) {
      if (!disposed && generation === currentGeneration) storageFailed(error);
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    execute: inputs.execute,
    dispatch,
    start() {
      if (started) return started;
      disposed = false;
      subscriptions = subscribeWorkspaceRuntime({ state: () => state, dispatch, execute: inputs.execute, waiters, prepareThreadRequest: history.prepareThreadRequest });
      started = initialize(++generation);
      refreshEnvironment();
      return started;
    },
    async flush() {
      await started;
      subscriptions?.flush();
      await inputs.settled();
      while (effectsInFlight.size) await Promise.all([...effectsInFlight]);
      drafts.flush();
      if (state.storageError) {
        if (!persistence.pending) throw new Error(state.storageError);
        persistence.pending = persistenceState(state);
        await drainLatestPersistence(persistence, window.desktop.persistTaskStore);
        persistenceReady = true;
        await rawExecute({ type: "store.persisted" }).completed;
        persistence.pending = persistenceState(state);
      }
      await drainLatestPersistence(persistence, window.desktop.persistTaskStore);
    },
    dispose() {
      disposed = true;
      subscriptions?.stop();
      subscriptions = null;
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      drafts.dispose();
      started = null;
      generation += 1;
      history.invalidate();
      inputs.reset();
      effectsInFlight.clear();
      refreshInputs = [];
    },
  };
}
