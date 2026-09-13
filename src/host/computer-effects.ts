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

  "computer.rename": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.renameComputer(effect.name);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "computer.label": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.labelComputer(effect.id, effect.name);
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
      if (!result.ok) throw new Error(result.message);
      if (effect.draft) await dispatch({ type: "computers.forwarded", draft: effect.draft });
    } catch (error) {
      /** Whether anyone here is looking is told anew when the thread is next selected, so a line that dropped it is no error. */
      if (effect.inputs.every((input) => input.type === "view.set-focused")) return;
      const composer = effect.draft?.attachments?.key;
      await dispatch(composer === undefined
        ? { type: "action.failed", message: errorMessage(error) }
        : { type: "attachments.failed", ...(composer ? { taskId: composer } : {}), message: errorMessage(error) });
    }
  },
} satisfies Partial<EffectHandlers>;
