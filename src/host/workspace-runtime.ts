import { emptyWorkspaceState, sideChatIds, stateFromData, type WorkspaceState } from "../application/workspace-state.js";
import { unreadView } from "../application/thread-attention.js";
import { remoteUnreadCount } from "../application/computers.js";
import { reduce, type WorkspaceInput } from "../application/workspace-reducer.js";
import { executeWorkspaceInput, type WorkspaceExecution } from "../application/workspace-execution.js";
import type { KeyValueStorage } from "../application/task-store.js";
import { createTaskStore, createDraftPersistence } from "./draft-persistence.js";
import { loadViewPreferences } from "./view-preferences-store.js";
import { createRuntimeInputs } from "./runtime-inputs.js";
import { createSnoozeTimer } from "./snooze-timer.js";
import { createRuntimeHistory } from "./runtime-history.js";
import { errorMessage } from "./errors.js";
import { releaseThreadWaiters, type ThreadWaiter } from "./thread-requests.js";
import { nextMobileUpdate, noMobileView } from "./mobile-bridge.js";
import type { EnvironmentRefreshEffect } from "./effect-host.js";
import { runWorkspaceEffect } from "./workspace-effects.js";
import { subscribeWorkspaceRuntime } from "./runtime-subscriptions.js";
import type { WorkspaceRuntimeHost } from "./runtime-desktop.js";
import { drainLatestPersistence, hasPersistenceChanges, persistedStoreState, persistenceState, type PersistenceQueue } from "./workspace-persistence.js";

export type { RuntimeDesktop, WorkspaceRuntimeHost } from "./runtime-desktop.js";

function initialState(storage: KeyValueStorage, viewportWidth: number | undefined): WorkspaceState {
  const loaded = createTaskStore(storage).load();
  const state = loaded.ok ? stateFromData(loaded.data) : emptyWorkspaceState(loaded.errors.join(" "));
  return reduce(state, { type: "preferences.loaded", preferences: loadViewPreferences(storage, viewportWidth) }).state;
}

/** State, effects and durability have one lifetime, independent of whatever displays them. */
export function createWorkspaceRuntime(host: WorkspaceRuntimeHost) {
  const { desktop } = host;
  let state = initialState(host.storage, host.viewportWidth);
  let persistenceReady = false;
  let started: Promise<void> | null = null;
  let subscriptions: ReturnType<typeof subscribeWorkspaceRuntime> | null = null;
  const effectsInFlight = new Set<Promise<unknown>>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInputs: unknown[] = [];
  let generation = 0;
  let disposed = false;
  let badgeCount = -1;
  const listeners = new Set<() => void>();
  const persistence: PersistenceQueue = { persisted: null, pending: null, inFlight: null };
  const waiters = { current: [] as ThreadWaiter[] };
  const environmentRefreshes = { current: new Map<string, EnvironmentRefreshEffect | null>() };
  const mobileView = noMobileView();
  const drafts = createDraftPersistence(host.storage, () => state, dispatch);
  const snoozeTimer = createSnoozeTimer((at) => { void dispatch({ type: "snoozes.elapsed", at }); });
  const history = createRuntimeHistory({ state: () => state, load: (taskId) => desktop.loadThreadMessages(taskId), dispatch: (input) => rawExecute(input).completed.then(() => undefined), persistence });
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
    if (badgeCount === -1 || next.threads !== previous.threads || next.sideChats !== previous.sideChats || next.computers.paired !== previous.computers.paired) {
      const forked = sideChatIds(next);
      const count = unreadView(next, next.threads.filter((thread) => !forked.has(thread.id))).unreadCount + remoteUnreadCount(next.computers);
      if (count !== badgeCount) desktop.setBadgeCount(count);
      badgeCount = count;
    }
    const update = nextMobileUpdate(mobileView, next, Date.now());
    if (update) desktop.publishMobileView(update);
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
    void drainLatestPersistence(persistence, desktop.persistTaskStore).catch(storageFailed);
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
      perform: (effect, dispatch) => runWorkspaceEffect(effect, { dispatch, desktop, storage: host.storage, environmentRefreshes, scheduleSnoozeExpiry: snoozeTimer.schedule, surface: host.surface }),
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
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    void dispatch({ type: "view.refresh-environment" });
    refreshTimer = setInterval(() => void dispatch({ type: "view.refresh-environment" }), run ? 2_000 : 15_000);
  }

  async function initialize(currentGeneration: number) {
    try {
      const data = await desktop.loadTaskStore();
      if (disposed || generation !== currentGeneration) return;
      persistence.persisted = data ? persistedStoreState(data) : null;
      if (data) await dispatch({ type: "store.loaded", data, hiddenTasks: data.hiddenTasks });
      else await dispatch({ type: "store.absent" });
      await drafts.restore();
      if (state.currentId) await history.hydrate(state.currentId).catch((error) => rawExecute({ type: "action.failed", message: errorMessage(error) }).completed);
      if (disposed || generation !== currentGeneration) return;
      persistence.pending = persistenceState(state);
      persistenceReady = true;
      await drainLatestPersistence(persistence, desktop.persistTaskStore);
    } catch (error) {
      if (!disposed && generation === currentGeneration) storageFailed(error);
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    execute: inputs.execute,
    dispatch,
    /** Reads the stored drafts again, for text that arrived in storage after the start. */
    restoreDrafts: () => drafts.restore(),
    start() {
      if (started) return started;
      disposed = false;
      // Subscriptions can start effects immediately; their replies belong to this generation.
      generation += 1;
      subscriptions = subscribeWorkspaceRuntime({ state: () => state, dispatch, execute: inputs.execute, waiters, prepareThreadRequest: history.prepareThreadRequest, desktop, frame: host.frame });
      started = initialize(generation);
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
        await drainLatestPersistence(persistence, desktop.persistTaskStore);
        persistenceReady = true;
        await rawExecute({ type: "store.persisted" }).completed;
        persistence.pending = persistenceState(state);
      }
      await drainLatestPersistence(persistence, desktop.persistTaskStore);
    },
    dispose() {
      disposed = true;
      subscriptions?.stop();
      subscriptions = null;
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      drafts.dispose();
      snoozeTimer.dispose();
      started = null;
      generation += 1;
      history.invalidate();
      inputs.reset();
      effectsInFlight.clear();
      refreshInputs = [];
    },
  };
}

export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;
