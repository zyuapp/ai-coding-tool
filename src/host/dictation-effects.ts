import type { EffectHandlers } from "./effect-host.js";
import { errorMessage } from "./errors.js";

/** The microphone and speech model, each answer carried back under the hold it belongs to. */
export const dictationEffects = {
  "dictation.start": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.startDictation(effect.id);
      await dispatch({ type: "dictation.started", id: effect.id });
    } catch (error) {
      await dispatch({ type: "dictation.failed", id: effect.id, message: errorMessage(error) });
    }
  },

  "dictation.stop": async (effect, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "dictation.transcribed", id: effect.id, text: await desktop.stopDictation(effect.id) });
    } catch (error) {
      await dispatch({ type: "dictation.failed", id: effect.id, message: errorMessage(error) });
    }
  },

  "dictation.cancel": async (effect, { desktop }) => {
    await desktop.cancelDictation(effect.id).catch(() => undefined);
  },

  "dictation.cancel-download": async (_effect, { dispatch, desktop }) => {
    await desktop.cancelDictationDownload().catch((error) => dispatch({ type: "action.failed", message: errorMessage(error) }));
  },

  "dictation.download": async (_effect, { dispatch, desktop }) => {
    try {
      await desktop.downloadDictationModel();
    } catch (error) {
      await dispatch({ type: "dictation.model", model: "failed", message: errorMessage(error) });
    }
  },
} satisfies Partial<EffectHandlers>;
