/** What each provider says about the plan the user is signed in on. */
import { settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";
import { AGENT_ENGINES } from "../../domain/agent-engine.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";

export const PLAN_USAGE_INPUTS = ["usage.read", "usage.reported"] as const;
type PlanUsageInput = Extract<WorkspaceInput, { type: (typeof PLAN_USAGE_INPUTS)[number] }>;

/**
 * Each connected computer is asked for its own limits, which arrive with its state. The ask goes
 * without `everywhere`, so a computer paired back to this one never asks it in return.
 */
function askedElsewhere(state: WorkspaceState): WorkspaceEffect[] {
  return state.computers.paired
    .filter((computer) => computer.status === "connected" && supportsComputerCommand(computer.capabilities, { type: "usage.read" }))
    .map((computer) => ({ type: "computer.forward", id: computer.id, inputs: [{ type: "usage.read" }] }));
}

export function reducePlanUsage(state: WorkspaceState, input: PlanUsageInput): WorkspaceTransition {
  if (input.type === "usage.read") {
    /** What was read before stays on the page while the next read runs, so only the marks move. */
    const read = state.planUsage.read + 1;
    return settled(
      { ...state, planUsage: { ...state.planUsage, read, reading: [...AGENT_ENGINES] } },
      [...AGENT_ENGINES.map((engine) => ({ type: "read-plan-usage" as const, engine, read })), ...(input.everywhere ? askedElsewhere(state) : [])],
    );
  }
  /** Answers to a read the refresh button has already replaced are dropped wherever they arrive. */
  if (input.read !== state.planUsage.read) return settled(state);
  return settled({
    ...state,
    planUsage: {
      ...state.planUsage,
      reports: { ...state.planUsage.reports, [input.engine]: input.usage },
      reading: state.planUsage.reading.filter((engine) => engine !== input.engine),
    },
  });
}
