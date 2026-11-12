import { isSimulatorInput, usesMacClipboard, type SimulatorInput } from "../domain/simulator.js";
import { namesThread, optionalText, text, type Declarations } from "./command-declaration.js";
import { isString } from "./ipc.js";

/**
 * The iOS simulator panel. Each dock shows one device; a command carrying a `taskId` is a run driving
 * the device its own dock shows, and one carrying a `udid` names the device it acts on outright.
 */
export type SimulatorCommand =
  /** Shows the panel and boots the device it names, by UDID or name, else the dock's own, else a default. */
  | { type: "simulator.open"; taskId?: string; device?: string }
  /** Reads the devices this Mac has again. */
  | { type: "simulator.refresh" }
  /** Puts another device in the panel in front. */
  | { type: "simulator.select"; udid: string }
  | { type: "simulator.input"; taskId?: string; udid?: string; input: SimulatorInput };

/**
 * A run's gestures go to the device its own dock shows, so it names itself and never a device outright.
 * The Mac's clipboard is the person's, so a run never moves text through it.
 */
function drivesSimulator(command: { taskId?: string; udid?: string; input: SimulatorInput }): boolean {
  return isString(command.taskId) && command.udid === undefined && !usesMacClipboard(command.input);
}

export const simulatorCommands = {
  "simulator.open": { fields: { taskId: optionalText, device: optionalText }, at: "panel", agent: namesThread },
  "simulator.refresh": { fields: {}, at: "panel" },
  "simulator.select": { fields: { udid: text }, at: "panel" },
  "simulator.input": { fields: { taskId: optionalText, udid: optionalText, input: isSimulatorInput }, at: "panel", agent: drivesSimulator },
} satisfies Declarations<SimulatorCommand>;
