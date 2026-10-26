import type { AgentEngine } from "../domain/agent-engine.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import type { ComputerStatus } from "../domain/computers.js";
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import type { PairedComputer } from "./computers.js";

/**
 * The plan limits each provider reports, the read they belong to, and which providers have yet to
 * answer it. A provider that has answered before keeps saying so while the next read runs.
 */
export type PlanUsageState = {
  read: number;
  reports: Partial<Record<AgentEngine, PlanUsage>>;
  reading: AgentEngine[];
  /** Warnings about a window running low the user has put away, by `usageWarningKey`. */
  dismissed: string[];
};

export const NO_PLAN_USAGE: PlanUsageState = { read: 0, reports: {}, reading: [], dismissed: [] };

/**
 * A paired computer's limits as the Usage page draws them: its own accounts, read there. `usage` is
 * null until its state arrives, and `supported` is false for a computer too old to be asked.
 */
export type ComputerUsage = { id: string; name: string; status: ComputerStatus; usage: PlanUsageState | null; supported: boolean };

export function computerUsage(paired: readonly PairedComputer[]): ComputerUsage[] {
  return paired.map((computer) => ({
    id: computer.id,
    name: computer.name,
    status: computer.status,
    usage: computer.state?.planUsage ?? null,
    supported: supportsComputerCommand(computer.capabilities, { type: "usage.read" }),
  }));
}

export function sameComputerUsage(before: readonly ComputerUsage[], next: readonly ComputerUsage[]) {
  return before.length === next.length && before.every((item, index) => {
    const other = next[index]!;
    return item.id === other.id && item.name === other.name && item.status === other.status && item.usage === other.usage && item.supported === other.supported;
  });
}
