/** The terminal panel's shells: opening, closing and restarting them, and what they did. */
import { focusDockTab, showDockTab } from "./dock-tabs.js";
import { TERMINAL_FOLDER_ERROR } from "./errors.js";
import { settled, rejected } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { currentFolder, dockFor, dockOwner, dockTabAfterClosing, ownerOfTerminal, withDock, type WorkspaceState } from "../workspace-state.js";
import { terminalTitle, type TerminalSession, type TerminalUpdate } from "../../domain/terminal.js";

export const TERMINAL_INPUTS = [
  "terminal.open", "terminal.select", "terminal.close", "terminal.restart", "terminal.input", "terminal.resize", "terminal.updated"
] as const;
type TerminalInput = Extract<WorkspaceInput, { type: (typeof TERMINAL_INPUTS)[number] }>;

/** What a shell did. Its output is not here: that goes straight to the view and never becomes state. */
export type TerminalEvent = { type: "terminal.updated"; update: TerminalUpdate };

/** The terminal panel's shells. `start` is idempotent: a terminal that already runs keeps its process. */
export type TerminalEffect =
  | { type: "terminal.start"; terminalId: string; cwd: string }
  | { type: "terminal.write"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string };

export function reduceTerminal(state: WorkspaceState, input: TerminalInput): WorkspaceTransition {
  switch (input.type) {
    case "terminal.open": {
      const owner = dockOwner(state);
      const cwd = input.cwd ?? currentFolder(state);
      if (!cwd) return rejected(state, TERMINAL_FOLDER_ERROR);
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

    case "terminal.restart": {
      const owner = ownerOfTerminal(state, input.terminalId);
      if (!owner) return settled(state);
      const dock = dockFor(state, owner);
      const old = dock.terminals.find((terminal) => terminal.id === input.terminalId)!;
      const terminal: TerminalSession = { id: crypto.randomUUID(), title: terminalTitle(old.cwd), cwd: old.cwd, taskId: old.taskId, status: "running" };
      const replaced = withDock({ ...state, actionError: null }, owner, { terminals: dock.terminals.map((item) => item === old ? terminal : item), terminalId: terminal.id });
      const restarted = showDockTab(replaced, owner, terminal.id);
      const focused = focusDockTab(restarted, owner, terminal.id);
      return settled(focused.state, [{ type: "terminal.close", terminalId: old.id }, { type: "terminal.start", terminalId: terminal.id, cwd: old.cwd }, ...focused.effects]);
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
