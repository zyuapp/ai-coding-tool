/** The terminal command the app installs: where it stands, and what is being done about it. */
import type { SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import type { CliSliceState } from "../state/machine-access.js";
import type { CliStatus } from "../../domain/cli.js";

export const CLI_INPUTS = ["cli.read", "cli.install", "cli.uninstall", "cli.read-status", "cli.failed"] as const;
type CliInput = Extract<WorkspaceInput, { type: (typeof CLI_INPUTS)[number] }>;

/** Where the terminal command stands after a read, an install or a removal, or why none could happen. */
export type CliEvent =
  | { type: "cli.read-status"; status: CliStatus }
  | { type: "cli.failed"; message: string };

export type CliEffect = { type: "cli.read" } | { type: "cli.install" } | { type: "cli.uninstall" };

export function reduceCli(state: CliSliceState, input: CliInput): SliceTransition<CliSliceState> {
  switch (input.type) {
    case "cli.read":
      return { effects: [{ type: "cli.read" }] };
    case "cli.install":
    case "cli.uninstall":
      return { patch: { cli: { ...state.cli, busy: true, error: null } }, effects: [{ type: input.type }] };
    case "cli.read-status":
      return { patch: { cli: { status: input.status, busy: false, error: state.cli.error } } };
    case "cli.failed":
      return { patch: { cli: { ...state.cli, busy: false, error: input.message } } };
  }
}
