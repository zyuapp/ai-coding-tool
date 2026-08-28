import type { WorkspaceEffect } from "../../application/workspace-reducer";
import { errorMessage } from "./errors";
import { saveViewPreferences } from "./local-view-preferences";
import { resolveRunWorkspace } from "./resolve-run-workspace";
import type { EffectHost } from "./effect-host";

/** What a run takes to start, what it is told while it runs, and what is read back about it. */
export type RunEffect = Extract<WorkspaceEffect, {
  type: "persist-preferences" | "load-subagent-activity" | "resolve-run-workspace" | "start-run"
    | "send-run-command" | "suggest-title";
}>;

export async function runRunEffect(effect: RunEffect, host: EffectHost): Promise<void> {
  const { dispatch, desktop } = host;
  switch (effect.type) {
    case "persist-preferences":
      saveViewPreferences(effect.preferences);
      return;

    case "load-subagent-activity":
      try {
        const activity = await desktop.loadSubagentActivity(effect.taskId, effect.subagentId);
        if (activity.length) await dispatch({ type: "subagent.activity.loaded", taskId: effect.taskId, subagentId: effect.subagentId, activity });
      } catch (error) {
        await dispatch({ type: "action.failed", message: errorMessage(error) });
      }
      return;

    case "resolve-run-workspace":
      return await dispatch(await resolveRunWorkspace(effect, desktop));

    case "start-run":
    case "send-run-command":
      desktop.send(effect.command);
      return;

    /** A title costs a model turn, so it lands on its own rather than holding back the send that asked for it. */
    case "suggest-title":
      void (async () => {
        const title = await desktop.suggestTaskTitle(effect.text, effect.attachments, effect.engine).catch(() => null);
        if (title) await dispatch({ type: "title.suggested", taskId: effect.taskId, title });
      })();
      return;
  }
}
