import type { WorkspaceEffect } from "../../application/workspace-reducer";
import { attachmentEffects } from "./attachment-effects";
import { projectEffects } from "./project-effects";
import { runEffects } from "./run-effects";
import { surfaceEffects } from "./surface-effects";
import { systemEffects } from "./system-effects";
import type { EffectHandler, EffectHandlers, EffectHost } from "./effect-host";

/** Every effect the reducer can describe, each with the one handler that carries it out. */
const handlers: EffectHandlers = { ...attachmentEffects, ...runEffects, ...projectEffects, ...surfaceEffects, ...systemEffects };

/**
 * Performs one effect the reducer described. Nothing here decides anything: each effect is carried out
 * as it was written, and whatever the outside answers goes back through the reducer as an event.
 */
export async function runWorkspaceEffect(effect: WorkspaceEffect, host: EffectHost): Promise<void> {
  await (handlers[effect.type] as EffectHandler<WorkspaceEffect["type"]>)(effect, host);
}
