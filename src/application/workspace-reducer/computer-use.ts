/** What the platform lets the app see and operate, and what the settings page is doing about it. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";

type ComputerUseInput = Extract<WorkspaceInput, {
  type: "computer-use.read" | "computer-use.enable" | "computer-use.restart" | "computer-use.permissions" | "computer-use.failed";
}>;

export function reduceComputerUse(state: WorkspaceState, input: ComputerUseInput): WorkspaceTransition {
  const access = state.computerUsePermissions;
  switch (input.type) {
    case "computer-use.read":
      return settled(state, [{ type: "computer-use.read" }]);

    case "computer-use.restart":
      return settled(state, [{ type: "computer-use.restart" }]);

    /** The platform's own dialog answers for this one, so the row waits on it rather than on a poll. */
    case "computer-use.enable":
      return settled(
        { ...state, computerUsePermissions: { ...access, busy: input.permission, error: null, requested: true } },
        [{ type: "computer-use.enable", permission: input.permission }],
      );

    case "computer-use.permissions": {
      /** A full set is only worth a restart to a window that sent the user off to grant one. */
      const restartRequired = access.restartRequired || (access.requested && input.permissions.accessibility && input.permissions.screenRecording);
      return settled({
        ...state,
        computerUsePermissions: {
          ...access,
          permissions: input.permissions,
          restartRequired,
          ...(input.enabling ? { busy: null } : {}),
        },
      });
    }

    case "computer-use.failed":
      return settled({ ...state, computerUsePermissions: { ...access, error: input.message, ...(input.enabling ? { busy: null } : {}) } });
  }
}
