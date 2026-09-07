import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { WorkspaceExecution } from "../../application/workspace-execution";
import { errorMessage } from "./errors";

type RuntimeInputHost = {
  generation(): number;
  active(generation: number): boolean;
  history: { needed(input: WorkspaceInput): string[]; hydrate(taskId: string): Promise<void> };
  execute(input: WorkspaceInput): WorkspaceExecution;
  track(completed: Promise<unknown>): void;
};

/** Inputs wait for their histories in arrival order; unrelated effects may complete independently. */
export function createRuntimeInputs(host: RuntimeInputHost) {
  let preparing: Promise<unknown> | null = null;
  function execute(input: WorkspaceInput): WorkspaceExecution {
    const needed = host.history.needed(input);
    if (!preparing && !needed.length) return host.execute(input);
    const inputGeneration = host.generation();
    const closed = (): WorkspaceExecution => {
      const result = { ok: false as const, message: "The workspace runtime is closed." };
      return { accepted: result, completed: Promise.resolve(result) };
    };
    const splitBatch = input.type === "agent.events" && needed.length > 0;
    const prepared = (preparing ?? Promise.resolve()).then(async () => {
      if (!host.active(inputGeneration)) return closed();
      if (input.type === "agent.events" && splitBatch) {
        const completions: WorkspaceExecution["completed"][] = [];
        let failure: string | undefined;
        for (const event of input.events) {
          const single: WorkspaceInput = "runId" in event ? { type: "run.event", event } : { type: "thread.event", event };
          try {
            for (const taskId of host.history.needed(single)) await host.history.hydrate(taskId);
            if (!host.active(inputGeneration)) return closed();
            completions.push(host.execute(single).completed);
          } catch (error) {
            if (!host.active(inputGeneration)) return closed();
            const message = errorMessage(error);
            failure = message;
            const failed = host.execute({ type: "action.failed", message });
            completions.push(failed.completed.then(() => ({ ok: false as const, message })));
          }
        }
        if (failure !== undefined) completions.push(host.execute({ type: "action.failed", message: failure }).completed);
        return {
          accepted: { ok: true as const },
          completed: Promise.all(completions).then((results) => results.find((result) => !result.ok) ?? { ok: true as const }),
        };
      }
      for (const taskId of host.history.needed(input)) await host.history.hydrate(taskId);
      if (!host.active(inputGeneration)) return closed();
      return host.execute(input);
    }).catch((error): WorkspaceExecution => {
      if (!host.active(inputGeneration)) return closed();
      const message = errorMessage(error);
      const result = { ok: false as const, message };
      const failed = host.execute({ type: "action.failed", message });
      return { accepted: result, completed: failed.completed.then(() => result) };
    });
    const queued = prepared.finally(() => { if (preparing === queued) preparing = null; });
    preparing = queued;
    const completed = prepared.then((execution) => execution.completed);
    if (splitBatch) {
      host.track(completed);
    }
    const accepted = input.type === "agent.events" ? { ok: true as const } : prepared.then((execution) => execution.accepted);
    return { accepted, completed };
  }

  return { execute, settled: () => preparing, reset: () => { preparing = null; } };
}
