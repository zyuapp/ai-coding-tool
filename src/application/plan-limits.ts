import type { AgentEngine } from "../domain/agent-engine.js";
import type { PlanUsage } from "../domain/plan-usage.js";

/**
 * The plan limits each provider reports, the read they belong to, and which providers have yet to
 * answer it. A provider that has answered before keeps saying so while the next read runs.
 */
export type PlanUsageState = {
  read: number;
  reports: Partial<Record<AgentEngine, PlanUsage>>;
  reading: AgentEngine[];
};

export const NO_PLAN_USAGE: PlanUsageState = { read: 0, reports: {}, reading: [] };
