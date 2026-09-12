import type { WorkspaceEffect } from "../application/workspace-reducer.js";
import { attachmentEffects } from "./attachment-effects.js";
import { computerEffects } from "./computer-effects.js";
import { projectEffects } from "./project-effects.js";
import { runEffects } from "./run-effects.js";
import { surfaceEffects } from "./surface-effects.js";
import { systemEffects } from "./system-effects.js";
import type { EffectHandler, EffectHandlers, EffectHost } from "./effect-host.js";

/** Every effect the reducer can describe, each with the one handler that carries it out. */
const handlers: EffectHandlers = { ...attachmentEffects, ...computerEffects, ...runEffects, ...projectEffects, ...surfaceEffects, ...systemEffects };

/**
 * Performs one effect the reducer described. Nothing here decides anything: each effect is carried out
 * as it was written, and whatever the outside answers goes back through the reducer as an event.
 */
export async function runWorkspaceEffect(effect: WorkspaceEffect, host: EffectHost): Promise<void> {
  await (handlers[effect.type] as EffectHandler<WorkspaceEffect["type"]>)(effect, host);
}
