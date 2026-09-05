import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { deriveView, promptKey } from "../../application/workspace-state";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import { threadHandleOptions } from "../../application/thread-projection";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import { applyTheme } from "../theme";
import { applyTypography } from "../typography";
import { workspaceActions } from "./workspace-actions";
import { useWorkspaceSubscriptions } from "./workspace-subscriptions";
import { createWorkspaceConnection } from "./workspace-connection";

export type { ApprovalView } from "../../application/thread-run-state";

/** A view subscribes to the application runtime and sends it commands. */
export function useTaskWorkspace() {
  const held = useRef<ReturnType<typeof createWorkspaceConnection> | null>(null);
  if (!held.current) held.current = createWorkspaceConnection();
  const runtime = held.current;
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState);
  useEffect(() => { void runtime.start(); return () => runtime.dispose(); }, [runtime]);
  useWorkspaceSubscriptions({ restored: state.restored, dispatch: runtime.dispatch });
  const view = useMemo(() => deriveView(state), [state]);

  /** Held still across renders, so a memoized view is not redrawn by a handler that only looks new. */
  const dispatchCommand = useCallback((command: AppCommand) => runtime.dispatch(command), []);
  const dispatchInput = useCallback((input: WorkspaceInput) => runtime.dispatch(input), []);
  const actions = useMemo(() => workspaceActions(dispatchInput), [dispatchInput]);

  /**
   * The `@` menu's threads, per draft, since which threads are in scope depends on the draft. The
   * cache outlives one state so a menu whose threads did not move is handed back the same list, and
   * a surface holding that list is not redrawn by a change it never reads.
   */
  const handleCache = useRef<{ inputs: readonly unknown[]; byDraft: Map<string, ThreadHandleOption[]> }>({ inputs: [], byDraft: new Map() });
  const threadHandlesFor = useCallback((draftKey: string) => {
    const current = runtime.getState();
    const inputs = [current.threads, current.projects, current.sideChats, current.activeRuns, current.pendingRuns, current.queuedMessages, current.draftProjectId] as const;
    const cache = handleCache.current;
    if (inputs.some((value, index) => cache.inputs[index] !== value)) {
      cache.inputs = inputs;
      cache.byDraft = new Map();
    }
    const known = cache.byDraft.get(draftKey);
    if (known) return known;
    const options = threadHandleOptions(current, draftKey);
    cache.byDraft.set(draftKey, options);
    return options;
  }, []);

  useEffect(() => { applyTheme(view.theme, view.themeMode === "auto"); }, [view.theme, view.themeMode]);

  /**
   * Only a window set to "auto" reads the system's appearance, and it can only read it truthfully
   * once the platform has stopped being told which ground to use — so it re-reads after applying.
   */
  useEffect(() => {
    if (view.themeMode !== "auto") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const follow = () => void runtime.dispatch({ type: "view.system-scheme", dark: media.matches });
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

  return {
    ...view,
    threadHandles: threadHandlesFor(promptKey(state)),
    threadHandlesFor,
    /** The one door into the application. The named actions below are shorthand for the same commands. */
    dispatch: dispatchCommand,
    actions,
  };
}
