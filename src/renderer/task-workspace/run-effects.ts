import { errorMessage } from "./errors";
import { saveViewPreferences } from "./local-view-preferences";
import { resolveRunWorkspace } from "./resolve-run-workspace";
import { messageImages } from "../message-images";
import type { EffectHandlers } from "./effect-host";

/** What a run takes to start, what it is told while it runs, what is read back about it, and what its messages leave behind. */
export const runEffects = {
  "persist-preferences": (effect) => {
    saveViewPreferences(effect.preferences);
  },

  "load-subagent-activity": async (effect, { dispatch, desktop }) => {
    try {
      const activity = await desktop.loadSubagentActivity(effect.taskId, effect.subagentId);
      if (activity.length) await dispatch({ type: "subagent.activity.loaded", taskId: effect.taskId, subagentId: effect.subagentId, activity });
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "resolve-run-workspace": async (effect, { dispatch, desktop }) => {
    await dispatch(await resolveRunWorkspace(effect, desktop));
  },

  "start-run": (effect, { desktop }) => {
    desktop.send(effect.command);
  },

  "send-run-command": (effect, { desktop }) => {
    desktop.send(effect.command);
  },

  /** A title costs a model turn, so it lands on its own rather than holding back the send that asked for it. */
  "suggest-title": (effect, { dispatch, desktop }) => {
    void (async () => {
      const title = await desktop.suggestTaskTitle(effect.text, effect.attachments, effect.engine).catch(() => null);
      if (title) await dispatch({ type: "title.suggested", taskId: effect.taskId, title });
    })();
  },

  "preserve-message-images": async (effect, { desktop }) => {
    const files = messageImages(effect.text).map((image) => image.path);
    if (files.length) await desktop.preserveMessageImages(files, effect.root, effect.messageId);
  },
} satisfies Partial<EffectHandlers>;
