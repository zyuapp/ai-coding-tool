import type { ComputerUsePermission, ComputerUsePermissions } from "../domain/computer-use.js";

export type ComputerUsePort = {
  runtime: {
    computerUsePermissions(): Promise<ComputerUsePermissions>;
    enableComputerUse(permission: ComputerUsePermission): Promise<ComputerUsePermissions>;
    restartForComputerUse(): void;
  };
};
