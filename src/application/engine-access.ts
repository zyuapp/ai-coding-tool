import type { EngineCommand } from "../contracts/commands.js";
import { engineIsBlocked, engineNeedsAttention, type AgentEngine, type EngineAccess, type EngineReadiness, type EngineStatus } from "../domain/agent-engine.js";
import type { WorkspaceState } from "./workspace-state.js";

/** What main found out about an engine's access, on asking or after a sign-in, or why it could not. */
export type EngineEvent =
  | { type: "engine.status"; status: EngineStatus }
  | { type: "engine.failed"; message: string };

export type EngineEffect = EngineCommand;

export type EngineInput = EngineCommand | EngineEvent;

export type EngineTransition = { state: WorkspaceState; effects: EngineEffect[] };

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

export function reduceEngine(state: WorkspaceState, input: EngineInput): EngineTransition {
  if (input.type === "engine.status") {
    const engineStatus = { ...state.engineStatus, ...input.status };
    /** The error under the composer named an engine, so an answer that clears the engine clears it too. */
    const cleared = state.actionErrorPage === "engines" && nothingBlocked(engineStatus);
    return { state: { ...state, engineStatus, engineChecking: false, ...(cleared ? { actionError: null, actionErrorPage: null } : {}) }, effects: [] };
  }

  if (input.type === "engine.failed") return { state: { ...state, engineChecking: false, actionError: input.message }, effects: [] };

  if (input.type === "engine.read") {
    if (state.engineChecking) return { state, effects: [] };
    /** Asked on the way up, asked again whenever something is wrong, since only the user can fix that. */
    if (state.engineStatus === null) return { state: { ...state, engineStatus: {}, engineChecking: true }, effects: [{ type: "engine.read" }] };
    if (!input.refresh && !engineNeedsAttention(state.engineStatus)) return { state, effects: [] };
    return { state: { ...state, engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
  }

  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return { state, effects: [] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
