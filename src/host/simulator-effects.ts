import type { EffectHandlers } from "./effect-host.js";
import { errorMessage } from "./errors.js";
import type { HostModule } from "./host-module.js";

/** How long a run counts as driving a device after its last gesture. */
const DRIVING_MS = 4_000;

/** The simulator panel's devices: reading them, booting one, and the gestures sent to it. */
export const simulatorEffects = {
  "simulator.list": async (_effect, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "simulator.listed", ...await desktop.listSimulators() });
    } catch (error) {
      await dispatch({ type: "simulator.listed", availability: { status: "unsupported", reason: errorMessage(error) }, devices: [] });
    }
  },

  "simulator.boot": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.bootSimulator(effect.udid);
      await dispatch({ type: "simulator.booted", udid: effect.udid });
    } catch (error) {
      await dispatch({ type: "simulator.failed", udid: effect.udid, message: errorMessage(error) });
    }
  },

  "simulator.input": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.simulatorInput(effect.udid, effect.input);
      if (effect.input.kind === "rotate") await dispatch({ type: "simulator.turned", udid: effect.udid, orientation: effect.input.orientation });
    } catch (error) {
      await dispatch({ type: "simulator.refused", message: errorMessage(error) });
    } finally {
      const seq = effect.seq;
      if (seq !== undefined) setTimeout(() => void dispatch({ type: "simulator.idle", seq }), DRIVING_MS);
    }
  },
} satisfies Partial<EffectHandlers>;

export const simulatorHost = {
  effects: simulatorEffects,
  subscribe: (host) => { void host.dispatch({ type: "simulator.refresh" }); },
} satisfies HostModule;
