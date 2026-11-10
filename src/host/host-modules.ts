import type { WorkspaceEffect } from "../application/workspace-reducer.js";
import { attachmentHost } from "./attachment-effects.js";
import { automationHost } from "./automation-effects.js";
import { browserHost } from "./browser-effects.js";
import { computerHost } from "./computer-effects.js";
import { dictationHost } from "./dictation-effects.js";
import type { EffectHandlers } from "./effect-host.js";
import { engineHost } from "./engine-effects.js";
import { findHost } from "./find-effects.js";
import type { HostModule } from "./host-module.js";
import { mobileHost } from "./mobile-bridge.js";
import { projectHost } from "./project-effects.js";
import { runHost } from "./run-effects.js";
import { simulatorHost } from "./simulator-effects.js";
import { surfaceHost } from "./surface-effects.js";
import { systemHost } from "./system-effects.js";
import { terminalHost } from "./terminal-effects.js";
import { updateHost } from "./update-effects.js";

/** Every capability's host module, in the order their subscriptions start. */
const MODULES = [
  engineHost, simulatorHost, runHost, mobileHost, updateHost, dictationHost, browserHost, terminalHost, findHost,
  automationHost, projectHost, computerHost, attachmentHost, surfaceHost, systemHost,
] as const;

export const HOST_MODULES: readonly HostModule[] = MODULES;

type Handled<Module> = Module extends { effects: infer Table } ? keyof Table & WorkspaceEffect["type"] : never;

/** Every effect the reducer can describe, each with the one handler that carries it out. It fails to compile while one has none. */
export const EFFECT_HANDLERS: EffectHandlers = Object.assign({}, ...MODULES.map((module) => module.effects)) as EffectHandlers<Handled<(typeof MODULES)[number]>>;
