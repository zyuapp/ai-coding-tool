import type { SimulatorAvailability, SimulatorDevice, SimulatorFrame, SimulatorInput, SimulatorShot, SimulatorSnapshot } from "../domain/simulator.js";

export type SimulatorPort = {
  runtime: {
    /** The simulators this Mac has, and whether it can run the panel at all. */
    listSimulators(): Promise<{ availability: SimulatorAvailability; devices: SimulatorDevice[] }>;
    /** Boots a simulator without a window, resolving once it can take input. */
    bootSimulator(udid: string): Promise<void>;
    /** Shuts a simulator down if this app started it; one started elsewhere keeps running. */
    shutdownSimulator(udid: string): Promise<void>;
    simulatorInput(udid: string, input: SimulatorInput): Promise<void>;
    /** The app on screen as its accessibility tree, each element given a ref only this read's taps accept. */
    describeSimulator(udid: string, device: string): Promise<SimulatorSnapshot>;
    captureSimulator(udid: string): Promise<SimulatorShot>;
  };
  windowCalls: {
    /** Streams a device's screen to this window while at least one view watches it. */
    watchSimulator(udid: string): Promise<void>;
    unwatchSimulator(udid: string): Promise<void>;
  };
  windowOwn: {
    onSimulatorFrame(listener: (frame: SimulatorFrame) => void): () => void;
  };
};
