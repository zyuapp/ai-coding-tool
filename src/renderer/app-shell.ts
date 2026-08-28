import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MessageLinkActions } from "./components/MarkdownMessage";
import type { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;
type Dispatch = Workspace["dispatch"];

/** The subagent the dock is inspecting, dropped whenever the thread, the run or the panel it belongs to goes. */
export function useSubagentInspection(workspace: Workspace) {
  const [selected, setSelected] = useState<string | null>(null);
  const inspected = workspace.subagents.find((subagent) => subagent.id === selected);

  useEffect(() => {
    if (selected && !workspace.subagents.some((subagent) => subagent.id === selected)) setSelected(null);
  }, [workspace.currentTask?.id, workspace.subagents, selected]);

  useEffect(() => {
    setSelected(null);
  }, [workspace.currentTask?.id]);

  useEffect(() => {
    if (!workspace.dockPanels.includes("agents")) setSelected(null);
  }, [workspace.dockPanels]);

  const inspect = useCallback((id: string) => {
    setSelected(id);
    void workspace.actions.inspectSubagent(id);
  }, [workspace.actions]);

  function close() {
    setSelected(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.agents-panel input, .agents-panel button')?.focus());
  }

  return { inspected, inspect, close, clear: () => setSelected(null) };
}

/** Esc serves whatever is nearest: an overlay claims it first, then a menu, the find bar, and last the run. */
export function useEscapeLayers(workspace: Workspace) {
  useEffect(() => {
    function handleKeys(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (workspace.jump) void workspace.actions.closeJump();
      else if (workspace.openMenu !== null) workspace.actions.setOpenMenu(null);
      else if (workspace.settingsOpen) void workspace.actions.setSettingsOpen(false);
      else if (workspace.find) workspace.actions.closeFind();
      else void workspace.actions.cancelRun();
    }
    window.addEventListener("keydown", handleKeys);
    return () => {
      window.removeEventListener("keydown", handleKeys);
    };
  }, [workspace.actions, workspace.jump, workspace.openMenu, workspace.settingsOpen, workspace.find]);
}

/** Held still, so a link in a settled message is not a fresh handler on every render of the shell. */
export function useLatestDispatch(dispatch: Dispatch): RefObject<Dispatch> {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  return dispatchRef;
}

/**
 * A view taken off screen leaves the caret nowhere a keystroke can reach, and a window with no
 * caret answers no typing at all. Whenever one goes the composer takes the keyboard back, unless a
 * page or the settings sheet is the one holding it.
 */
export function useComposerFocusRecovery(dispatchRef: RefObject<Dispatch>, view: {
  dockOpen: boolean;
  sidebarOpen: boolean;
  settingsVisible: boolean;
  pageTookKeys: boolean;
  dockFocus: Workspace["dockFocus"];
  dockTab: string;
}) {
  const { dockOpen, sidebarOpen, settingsVisible, pageTookKeys, dockFocus, dockTab } = view;
  useEffect(() => {
    if (pageTookKeys || settingsVisible) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const stranded = !active || active === document.body || !active.isConnected || active.closest("[hidden],[inert]") !== null;
      if (stranded) void dispatchRef.current({ type: "view.focus-composer" });
    });
    return () => cancelAnimationFrame(frame);
  }, [dockOpen, sidebarOpen, settingsVisible, pageTookKeys, dockFocus, dockTab]);
}

/** What a link inside a message reaches for: another thread, a file, or a page of its own. */
export function useMessageLinks(dispatchRef: RefObject<Dispatch>) {
  return useMemo<MessageLinkActions>(() => ({
    selectTask: (taskId: string) => void dispatchRef.current({ type: "task.select", taskId }),
    openFile: (path: string, line: number | null) => void dispatchRef.current({ type: "file.open", path, line: line ?? undefined }),
    openUrlInApp: (url: string) => void dispatchRef.current({ type: "browser.open", url, newTab: true }),
  }), []);
}
