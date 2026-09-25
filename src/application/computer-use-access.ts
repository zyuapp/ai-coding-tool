import type { ComputerUsePermission, ComputerUsePermissions } from "../domain/computer-use.js";

/**
 * What the platform lets the app see and operate: what it last said, which permission its own dialog
 * is up for, what went wrong, whether the user was sent to grant one, and whether the set now in
 * place needs a restart to take effect.
 */
export type ComputerUseAccessState = {
  permissions: ComputerUsePermissions | null;
  busy: ComputerUsePermission | null;
  error: string | null;
  requested: boolean;
  restartRequired: boolean;
};

export const NO_COMPUTER_USE_ACCESS: ComputerUseAccessState = { permissions: null, busy: null, error: null, requested: false, restartRequired: false };
