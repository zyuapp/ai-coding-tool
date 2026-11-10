import type { ComputerUsePermission } from "../domain/computer-use.js";
import { literals, type Declarations } from "./command-declaration.js";

/**
 * What the platform lets the app see and operate. Reading asks the platform; enabling sends the user
 * to its own permission dialog; restarting is what a newly complete set needs to take effect.
 */
export type ComputerUseAccessCommand =
  | { type: "computer-use.read" }
  | { type: "computer-use.enable"; permission: ComputerUsePermission }
  | { type: "computer-use.restart" };

export const computerUseCommands = {
  "computer-use.read": { fields: {}, at: "local" },
  "computer-use.enable": { fields: { permission: literals("accessibility", "screenRecording") }, at: "local" },
  "computer-use.restart": { fields: {}, at: "local" },
} satisfies Declarations<ComputerUseAccessCommand>;
