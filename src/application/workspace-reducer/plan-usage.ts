/** What each provider says about the plan the user is signed in on. */
import type { SliceTransition } from "./slice.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import type { PlanUsageSliceState } from "../state/machine-access.js";
import type { ComputersSliceState } from "../state/computers.js";
import { AGENT_ENGINES } from "../../domain/agent-engine.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AgentEngine } from "../../domain/agent-engine.js";
import type { PlanUsage } from "../../domain/plan-usage.js";

export const PLAN_USAGE_INPUTS = ["usage.read", "usage.reported", "usage.dismiss-warning"] as const;
type PlanUsageInput = Extract<WorkspaceInput, { type: (typeof PLAN_USAGE_INPUTS)[number] }>;

/** What one provider says about its plan, named by the read it answers. */
export type PlanUsageEvent = { type: "usage.reported"; engine: AgentEngine; read: number; usage: PlanUsage };

export type PlanUsageEffect = { type: "read-plan-usage"; engine: AgentEngine; read: number };

/**
 * Each connected computer is asked for its own limits, which arrive with its state. The ask goes
 * without `everywhere`, so a computer paired back to this one never asks it in return.
 */
function askedElsewhere(state: ComputersSliceState): WorkspaceEffect[] {
  return state.computers.paired
    .filter((computer) => computer.status === "connected" && supportsComputerCommand(computer.capabilities, { type: "usage.read" }))
    .map((computer) => ({ type: "computer.forward", id: computer.id, inputs: [{ type: "usage.read" }] }));
}

export function reducePlanUsage(state: PlanUsageSliceState & ComputersSliceState, input: PlanUsageInput): SliceTransition<PlanUsageSliceState> {
  if (input.type === "usage.read") {
    /** What was read before stays on the page while the next read runs, so only the marks move. */
    const read = state.planUsage.read + 1;
    return {
      patch: { planUsage: { ...state.planUsage, read, reading: [...AGENT_ENGINES] } },
      effects: [...AGENT_ENGINES.map((engine) => ({ type: "read-plan-usage" as const, engine, read })), ...(input.everywhere ? askedElsewhere(state) : [])],
    };
  }
  if (input.type === "usage.dismiss-warning") {
    if (state.planUsage.dismissed.includes(input.warning)) return {};
    return { patch: { planUsage: { ...state.planUsage, dismissed: [...state.planUsage.dismissed, input.warning] } } };
  }
  /** Answers to a read the refresh button has already replaced are dropped wherever they arrive. */
  if (input.read !== state.planUsage.read) return {};
  return {
    patch: { planUsage: {
      ...state.planUsage,
      reports: { ...state.planUsage.reports, [input.engine]: input.usage },
      reading: state.planUsage.reading.filter((engine) => engine !== input.engine),
    } },
  };
}
