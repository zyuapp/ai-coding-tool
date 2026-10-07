import type { AgentSettingsReloadEvent } from "../contracts/ipc.js";
import type { EngineCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineIsBlocked, engineLabel, engineNeedsAttention, engineNotice, type AgentEngine, type EngineAccess, type EngineReadiness, type EngineStatus } from "../domain/agent-engine.js";
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

/** Engine work, and the toasts that say what the app did to an engine on its own. */
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

/** True when the engine's installed command is behind the app and the app can bring it up to date. */
function updatable(state: Pick<WorkspaceState, "engineStatus">, engine: AgentEngine) {
  return engineNotice(engine, engineReadinessOf(state, engine))?.updatable === true;
}

/**
 * Starts the next engine the app is updating on its own, once nothing else is updating, since package
 * managers lock. One the user has brought up to date meanwhile is passed over.
 */
function nextAutoUpdate(state: WorkspaceState): EngineTransition {
  if (state.engineUpdating || !state.engineAutoUpdates?.length) return { state, effects: [] };
  const queue = state.engineAutoUpdates.filter((engine) => updatable(state, engine));
  const engine = queue[0];
  const next = queue.length === state.engineAutoUpdates.length ? state : { ...state, engineAutoUpdates: queue };
  if (!engine) return { state: next, effects: [] };
  const { version, required } = engineReadinessOf(state, engine);
  const label = engineLabel(engine);
  const shown = withToast({ ...next, engineUpdating: engine }, { tone: "progress", title: `Updating ${label}`, message: `${label} ${version ?? "on this machine"} is behind ${required}.`, subject: engine });
  return { state: shown.state, effects: [{ type: "engine.update", engine }, ...shown.effects] };
}

/** Says how an update the app started on its own went, then starts the next one. */
function finishAutoUpdate(state: WorkspaceState, toast: Omit<Toast, "id">): EngineTransition {
  const shown = withToast({ ...state, engineAutoUpdates: state.engineAutoUpdates?.slice(1) ?? [] }, toast);
  const after = nextAutoUpdate(shown.state);
  return { state: after.state, effects: [...shown.effects, ...after.effects] };
}

/** What the app tells the user once it has updated an engine on its own: the version it reached, or that it is still behind. */
function autoUpdateToast(state: WorkspaceState, engine: AgentEngine): Omit<Toast, "id"> {
  const label = engineLabel(engine);
  const { version, required, fix } = engineReadinessOf(state, engine);
  if (updatable(state, engine)) {
    return { tone: "error", title: `Couldn't update ${label}`, message: `${label} ${version ?? "on this machine"} is still behind ${required}.${fix ? ` Run \`${fix}\` in your terminal.` : ""}`, subject: engine };
  }
  return { tone: "success", title: `${label} updated`, ...(version ? { message: `Now on ${version}.` } : {}), subject: engine };
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
      /** The first answer of a launch is the one that finds what fell behind the app, which is updated without asking. */
      if (state.engineAutoUpdates !== null) return { state: read, effects: [] };
      return nextAutoUpdate({ ...read, engineAutoUpdates: AGENT_ENGINES.filter((engine) => updatable(read, engine)) });
    }
    const updated = { ...next, engineUpdating: null };
    if (state.engineAutoUpdates?.[0] !== input.engine) return nextAutoUpdate(updated);
    return finishAutoUpdate(updated, autoUpdateToast(updated, input.engine));
  }

  if (input.type === "engine.failed") return { state: { ...state, engineChecking: false, actionError: input.message }, effects: [], result: { ok: false, message: input.message } };

  if (input.type === "engine.update-failed") {
    const label = engineLabel(input.engine);
    const updated = { ...state, engineUpdating: null };
    /** An update the user asked for answers where they asked; one the app started on its own says so in a toast. */
    if (state.engineAutoUpdates?.[0] !== input.engine) {
      const message = `Could not update ${label}. ${input.message}`;
      return { ...nextAutoUpdate({ ...updated, actionError: message }), result: { ok: false, message } };
    }
    return finishAutoUpdate(updated, { tone: "error", title: `Couldn't update ${label}`, message: input.message, subject: input.engine });
  }

  if (input.type === "engine.read") {
    if (state.engineChecking) return { state, effects: [] };
    /** Asked on the way up, asked again whenever something is wrong, since only the user can fix that. */
    if (state.engineStatus === null) return { state: { ...state, engineStatus: {}, engineChecking: true }, effects: [{ type: "engine.read" }] };
    if (!input.refresh && !engineNeedsAttention(state.engineStatus)) return { state, effects: [] };
    return { state: { ...state, engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
  }

  if (input.type === "engine.update") {
    /** Only a command the app can upgrade is, and one at a time, since package managers lock. */
    if (state.engineUpdating || !engineNotice(input.engine, engineReadinessOf(state, input.engine))?.updatable) return { state, effects: [] };
    return { state: { ...state, engineUpdating: input.engine, actionError: null, actionErrorPage: null }, effects: [input] };
  }

  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return { state, effects: [] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
