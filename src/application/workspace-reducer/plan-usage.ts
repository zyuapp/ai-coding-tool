/** What each provider says about the plan the user is signed in on. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";
import { AGENT_ENGINES } from "../../domain/agent-engine.js";

type PlanUsageInput = Extract<WorkspaceInput, { type: "usage.read" | "usage.reported" }>;

export function reducePlanUsage(state: WorkspaceState, input: PlanUsageInput): WorkspaceTransition {
  if (input.type === "usage.read") {
    /** What was read before stays on the page while the next read runs, so only the marks move. */
    const read = state.planUsage.read + 1;
    return settled(
      { ...state, planUsage: { ...state.planUsage, read, reading: [...AGENT_ENGINES] } },
      AGENT_ENGINES.map((engine) => ({ type: "read-plan-usage", engine, read })),
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
