/** The terminal command the app installs: where it stands, and what is being done about it. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";

type CliInput = Extract<WorkspaceInput, { type: "cli.read" | "cli.install" | "cli.uninstall" | "cli.read-status" | "cli.failed" }>;

export function reduceCli(state: WorkspaceState, input: CliInput): WorkspaceTransition {
  switch (input.type) {
    case "cli.read":
      return settled(state, [{ type: "cli.read" }]);
    case "cli.install":
    case "cli.uninstall":
      return settled({ ...state, cli: { ...state.cli, busy: true, error: null } }, [{ type: input.type }]);
    case "cli.read-status":
      return settled({ ...state, cli: { status: input.status, busy: false, error: state.cli.error } });
    case "cli.failed":
      return settled({ ...state, cli: { ...state.cli, busy: false, error: input.message } });
  }
}
