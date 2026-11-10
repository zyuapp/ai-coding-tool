import { NO_CLI, type CliState } from "../cli-installation.js";
import { NO_COMPUTER_USE_ACCESS, type ComputerUseAccessState } from "../computer-use-access.js";
import { NO_PLAN_USAGE, type PlanUsageState } from "../plan-limits.js";

export type CliSliceState = {
  /** The terminal command the app installs, as the settings page last read it. */
  cli: CliState;
};

export type PlanUsageSliceState = {
  /** What each provider says about the plan the user is signed in on. */
  planUsage: PlanUsageState;
};

export type ComputerUseSliceState = {
  /** What the platform lets the app see and operate, as settings last read it. */
  computerUsePermissions: ComputerUseAccessState;
  computerUseSetup: boolean;
};

export function initialCliState(): CliSliceState {
  return { cli: NO_CLI };
}

export function initialPlanUsageState(): PlanUsageSliceState {
  return { planUsage: NO_PLAN_USAGE };
}

export function initialComputerUseState(): ComputerUseSliceState {
  return { computerUsePermissions: NO_COMPUTER_USE_ACCESS, computerUseSetup: false };
}
