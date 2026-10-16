/**
 * Moving this computer to a newer build when someone asks, usually from another computer: the build
 * downloads, installs once nothing here is running, and the launch it brings upgrades every engine
 * the new build needs. Nobody has to be at this screen for any of it.
 */
import { engineReadinessOf, reduceEngine } from "./engine-access.js";
import { reduceToasts } from "./toasts.js";
import { threadActivity } from "./thread-activity.js";
import { rejected, settled } from "./workspace-reducer/shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";
import { AGENT_ENGINES, engineUpdate } from "../domain/agent-engine.js";

type AppUpdateInput = Extract<WorkspaceInput, { type: "app.update" | "app.cancel-update" | "app.build" | "app.launched" }>;

export const NO_UPDATE_TO_INSTALL = "There is no newer version to install.";

/**
 * How many threads an install would cut off. One paused on a usage limit is left out: it resumes on
 * its own after the restart, and waiting for it could take hours.
 */
export function runningThreads(state: WorkspaceState): number {
  const { working, paused } = threadActivity(state);
  let count = 0;
  for (const id of working) if (!paused.has(id)) count += 1;
  return count;
}

export function reduceAppUpdate(state: WorkspaceState, input: AppUpdateInput): WorkspaceTransition {
  switch (input.type) {
    case "app.build":
      return settled({ ...state, appBuild: input.build });
    /** The launch an update brought owes the engines that build needs, once they have been read. */
    case "app.launched":
      return reduceToasts({ ...state, engineUpgradesOwed: true }, input);
    /** An install already under way cannot be called back. */
    case "app.cancel-update":
      return settled(state.appUpdateRequest?.status === "installing" ? state : { ...state, appUpdateRequest: null });
    case "app.update": {
      const { appUpdate, appUpdateRequest } = state;
      if (appUpdate.status === "idle") return rejected(state, NO_UPDATE_TO_INSTALL);
      if (appUpdateRequest?.status === "waiting" || appUpdateRequest?.status === "installing") return settled(state);
      const waiting: WorkspaceState = { ...state, appUpdateRequest: { status: "waiting" } };
      return settled(waiting, appUpdate.status === "available" ? [{ type: "app.download-update", unattended: true }] : []);
    }
  }
}

/** Starts the upgrade of every engine this build needs and can upgrade itself, one after another. */
function upgradeNeededEngines(transition: WorkspaceTransition): WorkspaceTransition {
  const owed = { ...transition, state: { ...transition.state, engineUpgradesOwed: false } };
  return AGENT_ENGINES.reduce<WorkspaceTransition>((current, engine) => {
    const readiness = engineReadinessOf(current.state, engine);
    if (!readiness.required || !engineUpdate(readiness)?.command) return current;
    const next = reduceEngine(current.state, { type: "engine.update", engine });
    return { ...current, state: next.state, effects: [...current.effects, ...next.effects] };
  }, owed);
}

/**
 * Moves an asked-for update along whatever input arrives. A download that falls back to offering the
 * version has failed; a downloaded build installs the moment nothing is running. Engines owed by the
 * launch an update brought are upgraded once the launch's first read of them is in.
 */
export function reconcileAppUpdate(before: WorkspaceState, transition: WorkspaceTransition): WorkspaceTransition {
  const { state } = transition;
  let next = transition;
  if (state.engineUpgradesOwed && state.engineUpdatesOffered && !state.engineChecking) next = upgradeNeededEngines(next);
  const request = state.appUpdateRequest;
  const update = state.appUpdate;
  /** An install that left the build no longer ready failed, since a good one quits before saying anything. */
  if (request?.status === "installing" && update.status !== "ready") {
    return { ...next, state: { ...next.state, appUpdateRequest: { status: "failed", message: `Couldn't install ${request.version}.` } } };
  }
  if (request?.status !== "waiting") return next;
  if (before.appUpdate.status === "downloading" && update.status === "available") {
    return { ...next, state: { ...next.state, appUpdateRequest: { status: "failed", message: `Couldn't download ${update.version}.` } } };
  }
  if (update.status !== "ready" || runningThreads(state) > 0) return next;
  return {
    ...next,
    state: { ...next.state, appUpdateRequest: { status: "installing", version: update.version } },
    effects: [...next.effects, { type: "app.install-update", unattended: true }],
  };
}
