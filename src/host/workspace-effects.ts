import type { WorkspaceEffect } from "../application/workspace-reducer.js";
import type { EffectHandler, EffectHost } from "./effect-host.js";
import { EFFECT_HANDLERS } from "./host-modules.js";

/**
 * Performs one effect the reducer described. Nothing here decides anything: each effect is carried out
 * as it was written, and whatever the outside answers goes back through the reducer as an event.
 */
export async function runWorkspaceEffect(effect: WorkspaceEffect, host: EffectHost): Promise<void> {
  await (EFFECT_HANDLERS[effect.type] as EffectHandler<WorkspaceEffect["type"]>)(effect, host);
}
