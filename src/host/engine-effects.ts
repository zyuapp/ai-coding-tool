import type { EngineStatus } from "../domain/agent-engine.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import type { EffectHandlers, EffectHost } from "./effect-host.js";
import { errorMessage, reportedMessage } from "./errors.js";
import type { HostModule } from "./host-module.js";

/** Where every engine stands: asked outright, or answered by an engine's own sign-in once it is over. An update answers apart, naming its engine. */
async function readEngines(ask: () => Promise<EngineStatus>, { dispatch }: EffectHost) {
  try {
    await dispatch({ type: "engine.status", status: await ask() });
  } catch (error) {
    await dispatch({ type: "engine.failed", message: errorMessage(error) });
  }
}

/** The engines a run can take, their settings, and what their plans have left. */
export const engineEffects = {
  "engine.reload-settings": async (_effect, { dispatch, desktop }) => {
    try { desktop.send({ type: "reload-settings" }); }
    catch (error) { await dispatch({ type: "engine.settings-reload-status", status: "failed", message: errorMessage(error) }); }
  },

  "read-plan-usage": async (effect, { dispatch, desktop }) => {
    const usage = await desktop.planUsage(effect.engine).catch((cause): PlanUsage => ({ status: "unavailable", message: reportedMessage(cause) }));
    await dispatch({ type: "usage.reported", engine: effect.engine, read: effect.read, usage });
  },

  "engine.read": (effect, host) => readEngines(() => host.desktop.engineStatus(effect.refresh), host),

  "engine.sign-in": (effect, host) => readEngines(() => host.desktop.signInEngine(effect.engine), host),

  "engine.update": async ({ engine }, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "engine.updated", engine, status: await desktop.updateEngine(engine) });
    } catch (error) {
      await dispatch({ type: "engine.update-failed", engine, message: errorMessage(error) });
    }
  },
} satisfies Partial<EffectHandlers>;

export const engineHost = {
  effects: engineEffects,
  subscribe: (host) => { void host.dispatch({ type: "engine.read" }); },
} satisfies HostModule;
