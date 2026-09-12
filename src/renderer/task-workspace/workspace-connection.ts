import { emptyWorkspaceState } from "../../application/workspace-state";
import { applyOptimisticEdits, optimisticEdit, type OptimisticEdit } from "../../application/optimistic-edits";
import { applyWorkspacePatches } from "../../application/workspace-patches";
import { reduce, type WorkspaceInput } from "../../application/workspace-reducer";
import { createWorkspaceRuntime } from "./workspace-runtime";
import { clearTerminalSearch, disposeTerminalView, searchTerminalView } from "./terminal-views";
import { errorMessage } from "./errors";

/** Embedders without a process bridge host the same runtime in their own environment. */
export function createWorkspaceConnection() {
  const bridge = window.workspace;
  if (!bridge) return createWorkspaceRuntime();
  let state = emptyWorkspaceState();
  let displayed = state;
  let revision = -1;
  let hydrated = false;
  let generation = 0;
  let stop: (() => void) | null = null;
  let stopSurface: (() => void) | null = null;
  let started: Promise<void> | null = null;
  let snapshot: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const edits = new Map<string, OptimisticEdit>();

  function notify() { for (const listener of listeners) listener(); }
  function rebase(error?: string) {
    const view = applyOptimisticEdits(state, edits.values(), revision);
    if (view.edits.length !== edits.size) {
      edits.clear();
      for (const edit of view.edits) edits.set(edit.key, edit);
    }
    let next = view.state;
    if (error !== undefined) next = reduce(next, { type: "action.failed", message: error }).state;
    if (next === displayed) return;
    displayed = next;
    notify();
  }
  function failed(error: unknown) {
    rebase(errorMessage(error));
  }
  function requestSnapshot(): Promise<void> {
    if (snapshot) return snapshot;
    const requestedGeneration = generation;
    const requested = Promise.resolve().then(async () => {
      if (requestedGeneration !== generation) return;
      const result = await bridge!.request();
      if (!result.ok && requestedGeneration === generation) failed(result.message);
    }).catch((error) => {
      if (requestedGeneration === generation) failed(error);
    }).finally(() => { if (snapshot === requested) snapshot = null; });
    snapshot = requested;
    return requested;
  }

  return {
    getState: () => displayed,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async dispatch(input: WorkspaceInput) {
      const requestedGeneration = generation;
      const edit = optimisticEdit(displayed, input);
      if (edit) {
        edits.delete(edit.key);
        edits.set(edit.key, edit);
        rebase();
      }
      try {
        const result = await bridge.request(edit?.input ?? input);
        if (requestedGeneration === generation && edit && edits.get(edit.key) === edit) {
          if (result.ok) edits.set(edit.key, { ...edit, revision: result.revision });
          else edits.delete(edit.key);
          rebase();
        }
      } catch (error) {
        if (requestedGeneration === generation) {
          if (edit && edits.get(edit.key) === edit) edits.delete(edit.key);
          failed(error);
        }
      }
    },
    start(): Promise<void> {
      if (started) return started;
      revision = -1;
      hydrated = false;
      stop = bridge.onUpdate((update) => {
        if ("state" in update) {
          state = update.state;
          hydrated = true;
        } else {
          if (update.revision <= revision) return;
          if (!hydrated || update.revision !== revision + 1) { void requestSnapshot(); return; }
          try {
            state = applyWorkspacePatches(state, update.patches);
          } catch {
            hydrated = false;
            void requestSnapshot();
            return;
          }
        }
        revision = update.revision;
        rebase();
      });
      stopSurface = bridge.onSurface((effect) => {
        if (effect.type === "terminal.close") disposeTerminalView(effect.terminalId);
        else if (effect.type === "find-in-terminal") searchTerminalView(effect.terminalId, effect.query, effect.forward);
        else clearTerminalSearch(effect.terminalId);
      });
      started = requestSnapshot();
      return started;
    },
    dispose() {
      stop?.();
      stopSurface?.();
      stop = null;
      stopSurface = null;
      started = null;
      snapshot = null;
      generation += 1;
      edits.clear();
      displayed = state;
    },
  };
}
