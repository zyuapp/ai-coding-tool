import { emptyWorkspaceState, promptKey, type WorkspaceState } from "../../application/workspace-state";
import { applyWorkspacePatches } from "../../application/workspace-patches";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import { reduce } from "../../application/workspace-reducer";
import { createWorkspaceRuntime } from "./workspace-runtime";
import { clearTerminalSearch, disposeTerminalView, searchTerminalView } from "./terminal-views";
import { errorMessage } from "./errors";
import { sameFindTarget, type FindTarget } from "../../domain/find";

type TextInput = Extract<WorkspaceInput, { type: "view.set-prompt" | "task.rename" | "worktree.menu-search" | "view.find-query" | "view.jump-query" | "annotation.note" }>;
type TextEdit = { key: string; input: TextInput; findTarget?: FindTarget; revision?: number };

/** Text edits name the field visible when they were typed, even if selection changes in transit. */
function localTextEdit(state: WorkspaceState, input: WorkspaceInput): TextEdit | null {
  switch (input.type) {
    case "view.set-prompt":
    case "annotation.note": {
      const taskId = input.taskId ?? promptKey(state);
      const key = [input.type, taskId];
      if (input.type === "annotation.note") key.push(input.annotationId);
      return { key: JSON.stringify(key), input: { ...input, taskId } };
    }
    case "task.rename": return { key: JSON.stringify([input.type, input.taskId]), input };
    case "worktree.menu-search": return { key: JSON.stringify([input.type, input.list]), input };
    case "view.jump-query": return { key: input.type, input };
    case "view.find-query":
      return state.find ? { key: input.type, input, findTarget: state.find.target } : null;
    default: return null;
  }
}

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
  const edits = new Map<string, TextEdit>();

  function notify() { for (const listener of listeners) listener(); }
  function rebase(error?: string) {
    let next = state;
    for (const edit of edits.values()) {
      // Command replies and state patches can arrive in either order across Electron IPC.
      if (edit.revision !== undefined && edit.revision <= revision) {
        edits.delete(edit.key);
        continue;
      }
      if (edit.findTarget && (!next.find || !sameFindTarget(edit.findTarget, next.find.target))) continue;
      next = reduce(next, edit.input).state;
    }
    if (error !== undefined) next = reduce(next, { type: "action.failed", message: error }).state;
    if (next === displayed) return;
    displayed = next;
    notify();
  }
  function finishEdit(edit: TextEdit | null) {
    if (!edit || edits.get(edit.key) !== edit) return false;
    edits.delete(edit.key);
    return true;
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
      const edit = localTextEdit(displayed, input);
      if (edit) {
        edits.delete(edit.key);
        edits.set(edit.key, edit);
        rebase();
      }
      try {
        const result = await bridge.request(edit?.input ?? input);
        if (requestedGeneration === generation && edit && edits.get(edit.key) === edit) {
          edit.revision = result.revision;
          if (!result.ok) finishEdit(edit);
          rebase();
        }
      } catch (error) {
        if (requestedGeneration === generation) {
          finishEdit(edit);
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
