import { DEFAULT_ENGINE, DEFAULT_MODEL, type AgentEngine, type AgentModel } from "../../domain/agent-engine.js";
import type { AgentDraft } from "../../domain/agent-draft.js";
import { DEFAULT_EFFORT, type AgentEffort, type ExecutionPolicy } from "../../domain/run.js";
import type { ThreadRole } from "../../domain/thread-role.js";

/** The branch a thread is to start from. `create` names one the repository does not have yet. */
export type DraftBranch = { name: string; create: boolean };

/** How the next new thread starts. */
export type NewThreadDraftState = {
  draftProjectId: string | null;
  draftPolicy: ExecutionPolicy;
  /** How the next new thread starts: which branch, and whether it gets a checkout of its own. */
  draftBranch: DraftBranch | null;
  draftWorktree: boolean;
  /** The checkout the next new thread starts in, when the user picked one the project already has. */
  draftWorktreeId: string | null;
  draftRole: ThreadRole | null;
  draftEngine: AgentEngine;
  draftModel: AgentModel;
  draftEffort: AgentEffort;
  draftFastMode: boolean;
};

export function initialNewThreadDraftState(): NewThreadDraftState {
  return {
    draftProjectId: null,
    draftPolicy: "confirm",
    draftBranch: null,
    draftWorktree: false,
    draftWorktreeId: null,
    draftRole: null,
    draftEngine: DEFAULT_ENGINE,
    draftModel: DEFAULT_MODEL,
    draftEffort: DEFAULT_EFFORT,
    draftFastMode: false,
  };
}

/** The agent choices the new-thread composer holds. */
export function draftOf(state: NewThreadDraftState): AgentDraft {
  return { engine: state.draftEngine, model: state.draftModel, effort: state.draftEffort, policy: state.draftPolicy, fastMode: state.draftFastMode };
}
