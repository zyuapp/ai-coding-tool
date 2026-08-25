/** The machine around the thread: its shells, its files, and the applications that open them. */
import { APP_FOLDER_ERROR, FILE_FOLDER_ERROR, TERMINAL_FOLDER_ERROR, focusDockTab, settled, showDockTab } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { currentFolder, dockFor, dockOwner, dockTabAfterClosing, ownerOfTerminal, taskFileRoots, withDock, type WorkspaceState } from "../workspace-state.js";
import { isAbsoluteFilePath } from "../../domain/markdown-links.js";
import { terminalTitle, type TerminalSession } from "../../domain/terminal.js";

type DesktopInput = Extract<WorkspaceInput, {
  type: "file.open" | "app.open-folder" | "terminal.open" | "terminal.select" | "terminal.close"
    | "terminal.input" | "terminal.resize" | "terminal.updated";
}>;

export function reduceDesktop(state: WorkspaceState, input: DesktopInput): WorkspaceTransition {
  switch (input.type) {
    case "file.open": {
      const roots = taskFileRoots(state, state.tasks.find((item) => item.id === (input.taskId ?? state.currentId)));
      if (!roots.length && !isAbsoluteFilePath(input.path)) return settled({ ...state, actionError: FILE_FOLDER_ERROR });
      return settled({ ...state, actionError: null }, [{ type: "file.open", roots, path: input.path, line: input.line ?? null }]);
    }

    case "app.open-folder": {
      const root = currentFolder(state);
      if (!root) return settled({ ...state, actionError: APP_FOLDER_ERROR });
      return settled({ ...state, actionError: null, openMenu: null }, [{ type: "app.open-folder", root, appId: input.appId }]);
    }

    case "terminal.open": {
      const owner = dockOwner(state);
      const cwd = input.cwd ?? currentFolder(state);
      if (!cwd) return settled({ ...state, actionError: TERMINAL_FOLDER_ERROR });
      const terminal: TerminalSession = {
        id: crypto.randomUUID(),
        title: terminalTitle(cwd),
        cwd,
        taskId: state.currentId,
        status: "running",
      };
      const dock = dockFor(state, owner);
      const opened = withDock({ ...state, actionError: null }, owner, {
        open: true,
        tab: terminal.id,
        terminals: [...dock.terminals, terminal],
        terminalId: terminal.id,
      });
      const focused = focusDockTab(opened, owner, terminal.id);
      return settled(focused.state, [{ type: "terminal.start", terminalId: terminal.id, cwd }, ...focused.effects]);
    }

    /** A shell that is asked for is a shell to type in, so it takes the keyboard as a side chat does. */
    case "terminal.select": {
      const owner = ownerOfTerminal(state, input.terminalId);
      if (!owner) return settled(state);
      const shown = withDock(showDockTab(state, owner, input.terminalId), owner, { terminalId: input.terminalId });
      return focusDockTab(shown, owner, input.terminalId);
    }

    case "terminal.close": {
      const owner = ownerOfTerminal(state, input.terminalId);
      if (!owner) return settled(state);
      const dock = dockFor(state, owner);
      const index = dock.terminals.findIndex((terminal) => terminal.id === input.terminalId);
      const tab = dock.tab === input.terminalId ? dockTabAfterClosing(state, owner, input.terminalId) : dock.tab;
      const terminals = dock.terminals.filter((terminal) => terminal.id !== input.terminalId);
      const next = dock.terminalId === input.terminalId
        ? terminals[index - 1] ?? terminals[index] ?? null
        : terminals.find((terminal) => terminal.id === dock.terminalId) ?? null;
      return settled(withDock(state, owner, { terminals, terminalId: next?.id ?? null, tab }), [{ type: "terminal.close", terminalId: input.terminalId }]);
    }

    /** Keystrokes and the size the shell believes it has. Neither is state, so only the effect happens. */
    case "terminal.input":
      return settled(state, [{ type: "terminal.write", terminalId: input.terminalId, data: input.data }]);

    case "terminal.resize":
      return settled(state, [{ type: "terminal.resize", terminalId: input.terminalId, cols: input.cols, rows: input.rows }]);

    case "terminal.updated": {
      const { terminalId, ...patch } = input.update;
      const owner = ownerOfTerminal(state, terminalId);
      if (!owner) return settled(state);
      return settled(withDock(state, owner, {
        terminals: dockFor(state, owner).terminals.map((terminal) => terminal.id === terminalId ? { ...terminal, ...patch } : terminal),
      }));
    }
  }
}
