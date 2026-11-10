/** The terminal command the app installs: where it stands, and what is being done about it. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { CliStatus } from "../../domain/cli.js";

export const CLI_INPUTS = ["cli.read", "cli.install", "cli.uninstall", "cli.read-status", "cli.failed"] as const;
type CliInput = Extract<WorkspaceInput, { type: (typeof CLI_INPUTS)[number] }>;

/** Where the terminal command stands after a read, an install or a removal, or why none could happen. */
export type CliEvent =
  | { type: "cli.read-status"; status: CliStatus }
  | { type: "cli.failed"; message: string };

export type CliEffect = { type: "cli.read" } | { type: "cli.install" } | { type: "cli.uninstall" };

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
