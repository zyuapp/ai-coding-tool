/** Whether a thread's session can be compacted or reviewed, read alike by the reducer that starts each and the view that offers it. */
import type { WorkspaceState } from "./workspace-state.js";
import { catalogOf } from "./state/engines.js";
import { threadWorkspaceId } from "./thread-location.js";
import { capabilitiesFor, modelSupportsManualCompaction, threadModel } from "../domain/agent-engine.js";
import type { Thread } from "../domain/thread.js";

/** A session compacts on request when its model offers it, its engine holds it, and it has reported its context. */
export function compactableSession(state: Pick<WorkspaceState, "engineStatus">, thread: Thread): boolean {
  const catalog = catalogOf(state);
  const model = threadModel(catalog, thread);
  return !thread.resourceStop && model !== undefined && modelSupportsManualCompaction(catalog, thread.engine, model)
    && thread.continuation?.provider === thread.engine
    && thread.contextUsage !== undefined;
}

/** A session reviews changes when its engine can, its engine holds it, and the thread works in a checkout. */
export function reviewableSession(state: Pick<WorkspaceState, "projects" | "worktrees">, thread: Thread): boolean {
  return !thread.resourceStop && capabilitiesFor(thread.engine).review
    && thread.continuation?.provider === thread.engine
    && Boolean(threadWorkspaceId(state, thread));
}
