/** How a slice's reducer answers when it changes only the state it owns, which the compiler holds it to. */
import type { WorkspaceCommandResult, WorkspaceEffect, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";

/** Fields of the slice's own state. Naming any other field of the workspace does not compile. */
export type OwnPatch<Own> = Partial<Own> & { [Field in Exclude<keyof WorkspaceState, keyof Own>]?: never };

export type SliceTransition<Own> = {
  patch?: OwnPatch<Own>;
  effects?: WorkspaceEffect[];
  result?: WorkspaceCommandResult;
  /** Takes down the error the window shows, which belongs to no slice that asks. */
  clearsError?: true;
};

/** A slice's reducer run on the whole state, with its patch joined in. One that changed nothing leaves the state as it was. */
export function owned<Own, Input>(reducer: (state: WorkspaceState, input: Input) => SliceTransition<Own>): (state: WorkspaceState, input: Input) => WorkspaceTransition {
  return (state, input) => {
    const { patch, effects = [], result, clearsError } = reducer(state, input);
    const next = patch || clearsError ? { ...state, ...patch, ...(clearsError ? { actionError: null } : {}) } : state;
    return result ? { state: next, effects, result } : { state: next, effects };
  };
}
