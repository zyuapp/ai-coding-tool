import { DIFF_PANEL, reduce, type WorkspaceCommandResult, type WorkspaceEffect, type WorkspaceInput } from "./workspace-reducer.js";
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
};

/** Acceptance is synchronous; completion includes only effects descended from this input. */
export function executeWorkspaceInput(input: WorkspaceInput, host: WorkspaceExecutionHost, origin: WorkspaceInput = input): WorkspaceExecution {
  if (host.active?.() === false) {
    const result: WorkspaceCommandResult = { ok: false, message: "The workspace runtime is closed." };
    return { accepted: result, completed: Promise.resolve(result) };
  }
  const transition = reduce(host.state(), input);
  host.commit(transition.state, input);
  const accepted: WorkspaceCommandResult = transition.result ?? { ok: true };
  const completed = Promise.all(transition.effects.map(async (effect): Promise<WorkspaceCommandResult> => {
    const replies: WorkspaceCommandResult[] = [];
    const dispatch = async (reply: WorkspaceInput) => {
      if (host.active?.() === false) return;
      await host.prepare?.(reply);
      const execution = executeWorkspaceInput(reply, host, origin);
      replies.push(await execution.completed);
    };
    try {
      await host.perform(effect, dispatch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dispatch({ type: "action.failed", message });
    }
    if (effect.type === "refresh-environment" && origin.type !== "view.refresh-environment") return { ok: true };
    if (effect.type === "read-diff" && !requestsDiff(origin)) return { ok: true };
    return combineResults({ ok: true }, replies);
  })).then((results) => combineResults(accepted, results));
  return { accepted, completed };
}

function requestsDiff(input: WorkspaceInput): boolean {
  if (input.type.startsWith("diff.")) return true;
  if (input.type === "view.open-dock-panel") return input.panel === DIFF_PANEL;
  if (input.type === "view.select-dock-tab") return input.tab === DIFF_PANEL;
  return false;
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
