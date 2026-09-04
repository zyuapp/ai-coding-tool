import type { WorktreeCommand } from "../../contracts/commands.js";
import type { WorkspaceState } from "../workspace-state.js";
import { settled } from "./shared.js";
import type { WorkspaceTransition } from "./types.js";

type Input = Extract<WorktreeCommand, { type: `checkout.${string}` }>;

export function reduceCheckout(state: WorkspaceState, input: Input): WorkspaceTransition {
  let panel = state.checkoutPanel;
  switch (input.type) {
    case "checkout.set-open": panel = { ...panel, open: input.open, mode: "threads", query: "", destination: null }; break;
    case "checkout.set-mode": panel = { ...panel, mode: input.mode, open: true, query: "", destination: null }; break;
    case "checkout.search": return settled({ ...state, checkoutPanel: { ...panel, query: input.query, destination: null } });
    case "checkout.select-destination": return settled({ ...state, checkoutPanel: { ...panel, destination: input.destination } });
  }
  const next = { ...state, checkoutPanel: panel };
  if (!panel.open || state.worktreeManagementLoading) return settled(next);
  return settled({ ...next, worktreeManagementLoading: true, worktreeManagementError: null }, [{ type: "list-worktrees" }]);
}
