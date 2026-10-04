import { reduce, type WorkspaceCommandResult, type WorkspaceEffect, type WorkspaceInput } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

export type WorkspaceExecution = {
  accepted: WorkspaceCommandResult | Promise<WorkspaceCommandResult>;
  completed: Promise<WorkspaceCommandResult>;
};

export type WorkspaceExecutionHost = {
  state: () => WorkspaceState;
  active?: () => boolean;
  commit: (state: WorkspaceState, input: WorkspaceInput) => void;
  perform: (effect: WorkspaceEffect, dispatch: (input: WorkspaceInput) => Promise<void>) => Promise<void>;
  prepare?: (input: WorkspaceInput) => Promise<void>;
  /** Receives follow-up work, which completion does not wait for; it never rejects. */
  track?: (work: Promise<unknown>) => void;
};

/**
 * Acceptance is synchronous. Completion waits for this input's own effects and the replies they
 * dispatch, but not for effects marked `followUp`, which are handed to `track` instead.
 */
export function executeWorkspaceInput(input: WorkspaceInput, host: WorkspaceExecutionHost): WorkspaceExecution {
  if (host.active?.() === false) {
    const result: WorkspaceCommandResult = { ok: false, message: "The workspace runtime is closed." };
    return { accepted: result, completed: Promise.resolve(result) };
  }
  const transition = reduce(host.state(), input);
  host.commit(transition.state, input);
  const accepted: WorkspaceCommandResult = transition.result ?? { ok: true };
  const owned: Promise<WorkspaceCommandResult>[] = [];
  for (const effect of transition.effects) {
    const work = performEffect(effect, host);
    if (!effect.followUp) owned.push(work);
    else host.track?.(work.catch(() => undefined));
  }
  return { accepted, completed: Promise.all(owned).then((results) => combineResults(accepted, results)) };
}

async function performEffect(effect: WorkspaceEffect, host: WorkspaceExecutionHost): Promise<WorkspaceCommandResult> {
  const replies: WorkspaceCommandResult[] = [];
  const dispatch = async (reply: WorkspaceInput) => {
    if (host.active?.() === false) return;
    await host.prepare?.(reply);
    replies.push(await executeWorkspaceInput(reply, host).completed);
  };
  try {
    await host.perform(effect, dispatch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dispatch({ type: "action.failed", message });
  }
  return combineResults({ ok: true }, replies);
}

function combineResults(initial: WorkspaceCommandResult, replies: WorkspaceCommandResult[]): WorkspaceCommandResult {
  if (!initial.ok) return initial;
  let result = initial;
  for (const reply of replies) {
    if (!reply.ok) return reply;
    if (reply.taskId !== undefined) result = reply;
  }
  return result;
}
