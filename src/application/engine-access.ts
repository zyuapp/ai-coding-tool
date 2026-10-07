import type { AgentSettingsReloadEvent } from "../contracts/ipc.js";
import type { EngineCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineIsBlocked, engineLabel, engineNeedsAttention, engineUpdate, type AgentEngine, type EngineAccess, type EngineReadiness, type EngineStatus } from "../domain/agent-engine.js";
import type { Toast } from "../domain/toast.js";
import { withToast, type ToastEffect } from "./toasts.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { WorkspaceCommandResult } from "./workspace-reducer/types.js";

/** What main found out about an engine's access, on asking, after a sign-in or after an update, or why it could not. */
export type EngineEvent =
  | AgentSettingsReloadEvent
  | { type: "engine.status"; status: EngineStatus }
  | { type: "engine.failed"; message: string }
  /** An update is over, with every engine read again after it. */
  | { type: "engine.updated"; engine: AgentEngine; status: EngineStatus }
  | { type: "engine.update-failed"; engine: AgentEngine; message: string };

export type EngineEffect = EngineCommand;

export type EngineInput = EngineCommand | EngineEvent;

/** Engine work, and the toasts that offer an update and say how it went. */
export type EngineTransition = { state: WorkspaceState; effects: Array<EngineEffect | ToastEffect>; result?: WorkspaceCommandResult };

/** Everything about engine access is named `engine.`, so one test sorts the whole family out of the way. */
export function isEngineInput(input: { type: string }): input is EngineInput {
  return input.type.startsWith("engine.");
}

/** An engine main has said nothing about is taken as ready; only main can say otherwise. */
export function engineReadinessOf(state: Pick<WorkspaceState, "engineStatus">, engine: AgentEngine): EngineReadiness {
  return state.engineStatus?.[engine] ?? { access: "ready" };
}

export function engineAccessOf(state: Pick<WorkspaceState, "engineStatus">, engine: AgentEngine): EngineAccess {
  return engineReadinessOf(state, engine).access;
}

/**
 * Asks main about the engines again, for a user who has just gone and installed or upgraded one.
 * Nothing is asked while every engine is fine, or while an earlier ask is still out, so coming back
 * to the window costs nothing on a machine with both engines in place.
 */
export function refreshEngines(state: WorkspaceState): EngineTransition {
  if (state.engineChecking || !engineNeedsAttention(state.engineStatus)) return { state, effects: [] };
  return { state: { ...state, engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
}

/** True while no engine stands between the user and a run, which is when an engine error is stale. */
function nothingBlocked(status: EngineStatus) {
  return !Object.entries(status).some(([engine, readiness]) => engineIsBlocked(engine as AgentEngine, readiness));
}

/** The key a closed offer is remembered by, so the same release is not offered again but the next one is. */
export function engineUpdateKey(engine: AgentEngine, target: string) {
  return `engine-update:${engine}@${target}`;
}

/** Puts a toast up alongside the engine work already decided. */
function toasted(transition: EngineTransition, toast: Omit<Toast, "id">): EngineTransition {
  const shown = withToast(transition.state, toast);
  return { ...transition, state: shown.state, effects: [...transition.effects, ...shown.effects] };
}

/**
 * The card that offers an engine's update when the launch first hears about the engines. It stays
 * until the user upgrades or closes it, and a closed one is not offered again for the same release.
 */
function updateOffer(state: WorkspaceState, engine: AgentEngine): Omit<Toast, "id"> | null {
  const readiness = engineReadinessOf(state, engine);
  const update = engineUpdate(readiness);
  if (!update || state.dismissedToasts.includes(engineUpdateKey(engine, update.target))) return null;
  const label = engineLabel(engine);
  const have = update.version ? `You have ${update.version}.` : "";
  const needed = readiness.required ? `This app needs ${readiness.required} or newer. ${have}` : have;
  return {
    tone: "update",
    title: `${label} ${update.target} is available`,
    message: update.command ? needed.trim() : `${needed} Update it the way you installed it.`.trim(),
    subject: engine,
    persistent: true,
    remember: engineUpdateKey(engine, update.target),
    ...(update.command ? { action: { label: "Upgrade", command: { type: "engine.update", engine } } } : {}),
  };
}

/** Starts an engine's update, saying so in place of the card that offered it. */
function startUpdate(state: WorkspaceState, engine: AgentEngine): EngineTransition {
  const label = engineLabel(engine);
  const update = engineUpdate(engineReadinessOf(state, engine));
  const message = update?.version ? `Moving from ${update.version} to ${update.target}.` : `Moving to ${update?.target}.`;
  return toasted(
    { state: { ...state, engineUpdating: engine, actionError: null, actionErrorPage: null }, effects: [{ type: "engine.update", engine }] },
    { tone: "progress", title: `Updating ${label}`, message, subject: engine, persistent: true },
  );
}

/** Starts the next engine waiting its turn, since package managers lock. One brought up to date meanwhile is passed over. */
function nextUpdate(state: WorkspaceState): EngineTransition {
  const queue = state.engineUpdateQueue.filter((engine) => engineUpdate(engineReadinessOf(state, engine))?.command);
  const [engine, ...rest] = queue;
  const next = { ...state, engineUpdateQueue: rest };
  return engine ? startUpdate(next, engine) : { state: queue.length === state.engineUpdateQueue.length ? state : next, effects: [] };
}

/** How an update went: the version it reached, or that the engine is still behind. A success leaves on its own. */
function updateResult(state: WorkspaceState, engine: AgentEngine): Omit<Toast, "id"> {
  const label = engineLabel(engine);
  const readiness = engineReadinessOf(state, engine);
  const update = engineUpdate(readiness);
  if (update) {
    const run = update.command ? ` Run \`${update.command}\` in your terminal.` : "";
    return { tone: "error", title: `Couldn't update ${label}`, message: `${label} is still on ${update.version ?? "an older version"}.${run}`, subject: engine, persistent: true };
  }
  return { tone: "success", title: `${label} updated`, ...(readiness.version ? { message: `Now on ${readiness.version}.` } : {}), subject: engine };
}

export function reduceEngine(state: WorkspaceState, input: EngineInput): EngineTransition {
  if (input.type === "engine.reload-settings") {
    if (state.agentSettingsReload === "reloading" || state.agentSettingsReload === "pending") return { state, effects: [] };
    const clearError = state.agentSettingsReload === "failed" && state.actionErrorPage === "engines";
    return { state: { ...state, agentSettingsReload: "reloading", ...(clearError ? { actionError: null, actionErrorPage: null } : {}) }, effects: [input] };
  }
  if (input.type === "engine.settings-reload-status") {
    return { state: { ...state, agentSettingsReload: input.status, ...(input.status === "failed" ? { actionError: input.message ?? "Could not reload agent settings.", actionErrorPage: "engines" as const } : {}) }, effects: [] };
  }
  if (input.type === "engine.status" || input.type === "engine.updated") {
    const engineStatus = { ...state.engineStatus, ...input.status };
    /** The error under the composer named an engine, so an answer that clears the engine clears it too. */
    const cleared = state.actionErrorPage === "engines" && nothingBlocked(engineStatus);
    const next: WorkspaceState = { ...state, engineStatus, ...(cleared ? { actionError: null, actionErrorPage: null } : {}) };
    if (input.type === "engine.status") {
      const read = { ...next, engineChecking: false };
      /** Only the launch's first answer offers updates; later ones are the user's own checks, answered in Settings. */
      if (state.engineUpdatesOffered) return { state: read, effects: [] };
      return AGENT_ENGINES.reduce<EngineTransition>((transition, engine) => {
        const offer = updateOffer(transition.state, engine);
        return offer ? toasted(transition, offer) : transition;
      }, { state: { ...read, engineUpdatesOffered: true }, effects: [] });
    }
    const updated = { ...next, engineUpdating: null };
    const shown = withToast(updated, updateResult(updated, input.engine));
    const after = nextUpdate(shown.state);
    return { state: after.state, effects: [...shown.effects, ...after.effects] };
  }

  if (input.type === "engine.failed") return { state: { ...state, engineChecking: false, actionError: input.message }, effects: [], result: { ok: false, message: input.message } };

  if (input.type === "engine.update-failed") {
    const shown = withToast({ ...state, engineUpdating: null }, { tone: "error", title: `Couldn't update ${engineLabel(input.engine)}`, message: input.message, subject: input.engine, persistent: true });
    const after = nextUpdate(shown.state);
    return { state: after.state, effects: [...shown.effects, ...after.effects], result: { ok: false, message: input.message } };
  }

  if (input.type === "engine.read") {
    if (state.engineChecking) return { state, effects: [] };
    /** Asked on the way up, asked again whenever something is wrong, since only the user can fix that. */
    if (state.engineStatus === null) return { state: { ...state, engineStatus: {}, engineChecking: true }, effects: [{ type: "engine.read" }] };
    if (!input.refresh && !engineNeedsAttention(state.engineStatus)) return { state, effects: [] };
    return { state: { ...state, engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
  }

  if (input.type === "engine.update") {
    /** Only an install the app can upgrade is, and only once; one asked for while another runs waits its turn. */
    const { engine } = input;
    if (!engineUpdate(engineReadinessOf(state, engine))?.command || state.engineUpdating === engine || state.engineUpdateQueue.includes(engine)) return { state, effects: [] };
    if (!state.engineUpdating) return startUpdate(state, engine);
    return toasted(
      { state: { ...state, engineUpdateQueue: [...state.engineUpdateQueue, engine] }, effects: [] },
      { tone: "progress", title: `Updating ${engineLabel(engine)}`, message: `Waiting for ${engineLabel(state.engineUpdating)} to finish.`, subject: engine, persistent: true },
    );
  }

  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return { state, effects: [] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
