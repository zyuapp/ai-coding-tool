import type { EngineCommand } from "../contracts/commands.js";
import type { AgentEngine, EngineAccess, EngineReadiness, EngineStatus } from "../domain/agent-engine.js";
import type { WorkspaceState } from "./workspace-state.js";

/** What main found out about an engine's access, on asking or after a sign-in. */
export type EngineEvent = { type: "engine.status"; status: EngineStatus };

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

export function reduceEngine(state: WorkspaceState, input: EngineInput): EngineTransition {
  if (input.type === "engine.status") return { state: { ...state, engineStatus: { ...state.engineStatus, ...input.status } }, effects: [] };
  /** Asked once: an engine is a process of its own, and the answer holds until a sign-in changes it. */
  if (input.type === "engine.read") return state.engineStatus === null ? { state: { ...state, engineStatus: {} }, effects: [input] } : { state, effects: [] };
  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return { state, effects: [] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
