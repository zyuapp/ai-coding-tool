/** What the platform lets the app see and operate, and what the settings page is doing about it. */
import { ownFields, type SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import { sameComputerUsePermissions } from "../../domain/computer-use.js";
import type { ComputerUseSliceState } from "../state/machine-access.js";
import type { ComputerUsePermission, ComputerUsePermissions } from "../../domain/computer-use.js";

export const COMPUTER_USE_INPUTS = [
  "computer-use.read", "computer-use.enable", "computer-use.restart", "computer-use.permissions", "computer-use.failed"
] as const;
type ComputerUseInput = Extract<WorkspaceInput, { type: (typeof COMPUTER_USE_INPUTS)[number] }>;

/** What the platform lets the app see and operate, and whether an enable was waiting on it. */
export type ComputerUseEvent =
  | { type: "computer-use.permissions"; permissions: ComputerUsePermissions; enabling?: true }
  | { type: "computer-use.failed"; message: string; enabling?: true };

export type ComputerUseEffect =
  | { type: "computer-use.read" }
  | { type: "computer-use.enable"; permission: ComputerUsePermission }
  | { type: "computer-use.restart" };

/** What the app may see and operate as one input leaves it. Only the functions here make one. */
class ComputerUseChange {
  private declare readonly owned: never;
  constructor(readonly view: ComputerUseSliceState) {}
}

export type ComputerUseEdit = ComputerUseChange;

export function computerUseOf(state: ComputerUseSliceState): ComputerUseEdit {
  return new ComputerUseChange(ownFields<ComputerUseSliceState>(state, { computerUsePermissions: true, computerUseSetup: true }));
}

/** The setup that holds settings open on its own, shown because a run needs it, or put away. */
export function setupShownIn(edit: ComputerUseEdit, shown: boolean): ComputerUseEdit {
  return new ComputerUseChange({ ...edit.view, computerUseSetup: shown });
}

export function reduceComputerUse(state: ComputerUseSliceState, input: ComputerUseInput): SliceTransition<ComputerUseSliceState> {
  const access = state.computerUsePermissions;
  switch (input.type) {
    case "computer-use.read":
      return { effects: [{ type: "computer-use.read" }] };

    case "computer-use.restart":
      return { effects: [{ type: "computer-use.restart" }] };

    /** The platform's own dialog answers for this one, so the row waits on it rather than on a poll. */
    case "computer-use.enable":
      return {
        patch: { computerUsePermissions: { ...access, busy: input.permission, error: null, requested: true } },
        effects: [{ type: "computer-use.enable", permission: input.permission }],
      };

    case "computer-use.permissions": {
      /** A full set is only worth a restart to a window that sent the user off to grant one. */
      const restartRequired = access.restartRequired || (access.requested && input.permissions.accessibility && input.permissions.screenRecording);
      /** The poll asks every second; an answer that says what the last one said leaves the window alone. */
      const unchanged = access.permissions !== null
        && sameComputerUsePermissions(access.permissions, input.permissions)
        && restartRequired === access.restartRequired
        && !(input.enabling && access.busy !== null);
      if (unchanged) return {};
      return { patch: {
        computerUsePermissions: {
          ...access,
          permissions: input.permissions,
          restartRequired,
          ...(input.enabling ? { busy: null } : {}),
        },
      } };
    }

    case "computer-use.failed":
      return { patch: { computerUsePermissions: { ...access, error: input.message, ...(input.enabling ? { busy: null } : {}) } } };
  }
}
