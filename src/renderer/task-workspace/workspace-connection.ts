import { emptyWorkspaceState } from "../../application/workspace-state";
import { applyOptimisticEdits, optimisticEdit, type OptimisticEdit } from "../../application/optimistic-edits";
import { applyWorkspacePatches } from "../../application/workspace-patches";
import { reduce, type WorkspaceInput } from "../../application/workspace-reducer";
import { VIEW_PREFERENCES_KEY } from "../../application/view-preferences";
import { DRAFT_PROMPTS_KEY } from "../../host/draft-persistence";
import { createWorkspaceRuntime } from "../../host/workspace-runtime";
import { noComputers } from "../../host/no-computers";
import type { WorkspaceSurfaceEffect } from "../../contracts/workspace-runtime";
import { clearTerminalSearch, disposeTerminalView, searchTerminalView } from "./terminal-views";
import { errorMessage } from "../../host/errors";

/** Set once the window's own stored preferences have been handed to the host, so they are never handed over twice. */
const MIGRATED_KEY = "aicodingtool.host-migrated.v1";

/** The next paint, or a moment later for a window the browser has stopped painting. */
const FRAME_FALLBACK_MS = 32;

function nextFrame(flush: () => void) {
  const frame = requestAnimationFrame(flush);
  const timer = setTimeout(flush, FRAME_FALLBACK_MS);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/** An effect that lives in this window's views: a terminal's search, or its disposal. */
function performSurface(effect: WorkspaceSurfaceEffect) {
  if (effect.type === "terminal.close") disposeTerminalView(effect.terminalId);
  else if (effect.type === "find-in-terminal") searchTerminalView(effect.terminalId, effect.query, effect.forward);
  else clearTerminalSearch(effect.terminalId);
}

/**
 * What this window still holds from when it hosted the runtime itself. A host that has not yet kept
 * preferences of its own takes these, so an update does not put the user back on the defaults.
 */
function storedValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of [VIEW_PREFERENCES_KEY, DRAFT_PROMPTS_KEY]) {
    const value = localStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return values;
}

/** Embedders without a process bridge host the same runtime in their own environment. */
export function createWorkspaceConnection() {
  const bridge = window.workspace;
  if (!bridge) return createWorkspaceRuntime({ desktop: { ...window.desktop, ...noComputers }, storage: localStorage, viewportWidth: window.innerWidth, surface: performSurface, frame: nextFrame });
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
  async function migrate() {
    if (localStorage.getItem(MIGRATED_KEY) !== null) return;
    const values = storedValues();
    if (Object.keys(values).length) await bridge!.migrate(values);
    localStorage.setItem(MIGRATED_KEY, "1");
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
          /** An edit the published revision already carries is settled, so it is dropped, not stamped. */
          if (result.ok && result.revision > revision) edits.set(edit.key, { ...edit, revision: result.revision });
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
      stopSurface = bridge.onSurface(performSurface);
      started = migrate().catch((error) => console.error("Could not hand stored preferences to the host:", error)).then(requestSnapshot);
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
