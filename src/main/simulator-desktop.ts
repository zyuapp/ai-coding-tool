import type { SimulatorPort } from "../contracts/simulator-port.js";
import { needsDesktop } from "./headless.js";
import type * as SimulatorHost from "./simulator-host.js";

/** The simulator panel's devices, driven from this process. */
export function simulatorDesktop(simulator: typeof SimulatorHost): SimulatorPort["runtime"] {
  return {
    listSimulators: () => simulator.listSimulators(),
    bootSimulator: (udid) => simulator.bootSimulator(udid),
    simulatorInput: (udid, input) => simulator.simulatorInput(udid, input),
    describeSimulator: (udid, device) => simulator.describeSimulator(udid, device),
    captureSimulator: (udid) => simulator.captureSimulator(udid),
  };
}

export const headlessSimulatorDesktop: SimulatorPort["runtime"] = {
  listSimulators: async () => ({ availability: { status: "unsupported" as const, reason: "The simulator needs the desktop app." }, devices: [] }),
  bootSimulator: needsDesktop("The simulator"),
  simulatorInput: needsDesktop("The simulator"),
  describeSimulator: needsDesktop("The simulator"),
  captureSimulator: needsDesktop("The simulator"),
};
