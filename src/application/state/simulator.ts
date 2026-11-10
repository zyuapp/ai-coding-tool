import { NO_SIMULATORS, type SimulatorState } from "../../domain/simulator.js";

export type SimulatorSliceState = {
  /** The simulator last picked or opened, which a dock with none of its own shows. */
  simulatorDevice: string | null;
  simulator: SimulatorState;
};

export function initialSimulatorState(): SimulatorSliceState {
  return { simulatorDevice: null, simulator: NO_SIMULATORS };
}
