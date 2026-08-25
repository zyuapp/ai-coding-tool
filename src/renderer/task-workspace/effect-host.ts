import type { WorkspaceEffect, WorkspaceInput } from "../../application/workspace-reducer";
import type { DesktopAPI } from "../../contracts/ipc";
import { errorMessage } from "./errors";

export type EnvironmentRefreshEffect = Extract<WorkspaceEffect, { type: "refresh-environment" }>;

/** The scan running per checkout, and the one follow-up a tick during it left behind. */
export type EnvironmentRefreshes = { current: Map<string, EnvironmentRefreshEffect | null> };

/** What performing an effect takes: the door back into the reducer, and the desktop it acts on. */
export type EffectHost = {
  dispatch: (input: WorkspaceInput) => Promise<void>;
  desktop: DesktopAPI;
  environmentRefreshes: EnvironmentRefreshes;
};

/** Work whose only answer is what went wrong with it. */
export async function reportFailure(host: EffectHost, work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    await host.dispatch({ type: "action.failed", message: errorMessage(error) });
  }
}
