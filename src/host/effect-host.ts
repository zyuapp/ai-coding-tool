import type { WorkspaceEffect, WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceSurfaceEffect } from "../contracts/workspace-runtime.js";
import type { KeyValueStorage } from "../application/task-store.js";
import type { RuntimeDesktop } from "./runtime-desktop.js";
import { errorMessage } from "./errors.js";

export type EnvironmentRefreshEffect = Extract<WorkspaceEffect, { type: "refresh-environment" }>;

/** The scan running per checkout, and the one follow-up a tick during it left behind. */
export type EnvironmentRefreshes = { current: Map<string, EnvironmentRefreshEffect | null> };

/** What performing an effect takes: the door back into the reducer, and the desktop it acts on. */
export type EffectHost = {
  dispatch: (input: WorkspaceInput) => Promise<void>;
  desktop: RuntimeDesktop;
  /** Where the view preferences are written, which is the host's to keep. */
  storage: KeyValueStorage;
  environmentRefreshes: EnvironmentRefreshes;
  scheduleSnoozeExpiry: (at: number | null) => void;
  /** Carries an effect to the window's own views. Absent where there is no window, which drops it. */
  surface?: ((effect: WorkspaceSurfaceEffect) => void) | undefined;
};

/** What one effect takes to be carried out. */
export type EffectHandler<Type extends WorkspaceEffect["type"]> = (effect: Extract<WorkspaceEffect, { type: Type }>, host: EffectHost) => void | Promise<void>;

/** Effects by name. A module's own table names the effects it owns, which is where that grouping lives. */
export type EffectHandlers<Type extends WorkspaceEffect["type"] = WorkspaceEffect["type"]> = { [T in Type]: EffectHandler<T> };

/** Work whose only answer is what went wrong with it. */
export async function reportFailure(host: EffectHost, work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    await host.dispatch({ type: "action.failed", message: errorMessage(error) });
  }
}
