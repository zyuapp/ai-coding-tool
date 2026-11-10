import type { WorkspaceState } from "../application/workspace-state.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { ThreadRequest } from "../contracts/threads.js";
import type { PreparedThreadRequest } from "./thread-reads.js";
import type { RunReports } from "./host-module.js";
import { HOST_MODULES } from "./host-modules.js";
import type { RuntimeDesktop, WorkspaceRuntimeHost } from "./runtime-desktop.js";
import type { ThreadWaiterList } from "./thread-requests.js";

export type RuntimeSubscriptionHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void>;
  execute: (input: WorkspaceInput) => WorkspaceExecution;
  waiters: ThreadWaiterList;
  prepareThreadRequest: (request: ThreadRequest) => Promise<PreparedThreadRequest | void>;
  hydrate?: (taskId: string) => Promise<void>;
  desktop: RuntimeDesktop;
  frame?: WorkspaceRuntimeHost["frame"];
};

/** Run and remote subscriptions outlive every mounted view. */
export function subscribeWorkspaceRuntime(host: RuntimeSubscriptionHost) {
  const stops: Array<() => void> = [];
  const flushers: Array<() => void> = [];
  /** What a run has reported so far is folded in before anything reads or acts on the thread it went to. */
  function flushAll() { for (const flush of flushers) flush(); }
  const runs: RunReports = { flushAll, holdReports: (flush) => { flushers.push(flush); } };
  for (const module of HOST_MODULES) {
    const stop = module.subscribe?.(host, runs);
    if (stop) stops.push(stop);
  }
  return {
    stop: () => { for (const stop of stops) stop(); },
    flush: flushAll,
  };
}
