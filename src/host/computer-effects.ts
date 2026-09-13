import { errorMessage } from "./errors.js";
import type { EffectHandlers } from "./effect-host.js";

/** Other computers running this app: finding them, pairing, and what is carried to one of them. */
export const computerEffects = {
  "computer.discover": async (_effect, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "computers.found", found: await desktop.discoverComputers() });
    } catch (error) {
      await dispatch({ type: "computers.search-failed", message: errorMessage(error) });
    }
  },

  "computer.pair": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.pairComputer(effect.host, effect.name, effect.code);
    } catch (error) {
      await dispatch({ type: "computers.pair-failed", message: errorMessage(error) });
    }
  },

  "computer.forget": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.forgetComputer(effect.id);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  /**
   * What the other computer refused comes back as this window's own error, since it is the one that
   * asked. A draft a send carried is let go of only once that computer has taken it.
   */
  "computer.forward": async (effect, { dispatch, desktop }) => {
    try {
      const result = await desktop.sendToComputer(effect.id, effect.inputs);
      if (!result.ok) await dispatch({ type: "action.failed", message: result.message });
      else if (effect.draft) await dispatch({ type: "computers.forwarded", draft: effect.draft });
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },
} satisfies Partial<EffectHandlers>;
