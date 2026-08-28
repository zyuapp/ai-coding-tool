import type { EngineCommand } from "../contracts/commands.js";
import type { AgentEngine, EngineAccess, EngineStatus } from "../domain/agent-engine.js";
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
export function engineAccessOf(state: Pick<WorkspaceState, "engineStatus">, engine: AgentEngine): EngineAccess {
  return state.engineStatus[engine] ?? "ready";
}

export function reduceEngine(state: WorkspaceState, input: EngineInput): EngineTransition {
  if (input.type === "engine.status") return { state: { ...state, engineStatus: { ...state.engineStatus, ...input.status } }, effects: [] };
  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return { state, effects: [] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
