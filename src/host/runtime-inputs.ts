import { agentEventInput } from "../application/workspace-reducer.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { InputScope } from "../application/input-scope.js";
import { errorMessage } from "./errors.js";

type RuntimeInputHost = {
  generation(): number;
  active(generation: number): boolean;
  /** What the window shows now, as `screenOf` reads it. */
  screen(): string;
  history: {
    needed(input: WorkspaceInput): string[];
    hydrate(taskId: string): Promise<void>;
    scope(input: WorkspaceInput): InputScope;
  };
  execute(input: WorkspaceInput): WorkspaceExecution;
  track(completed: Promise<unknown>): void;
};

const CLOSED = "The workspace runtime is closed.";
const MOVED = "The thread on screen changed before this could run.";

function refused(message: string): WorkspaceExecution {
  const result = { ok: false as const, message };
  return { accepted: result, completed: Promise.resolve(result) };
}

/**
 * Inputs wait only for the histories they need and for earlier pending inputs sharing one of their
 * keys, in arrival order per key. Everything else runs at once, whatever another thread is loading.
 */
export function createRuntimeInputs(host: RuntimeInputHost) {
  /** The newest pending input per key; the next input with that key starts after it. */
  const tails = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();

  function execute(arrived: WorkspaceInput): WorkspaceExecution {
    if (!tails.size && !host.history.needed(arrived).length) return host.execute(arrived);
    const { input, keys, screen } = host.history.scope(arrived);
    const needed = host.history.needed(input);
    for (const taskId of needed) keys.add(taskId);
    const before: Promise<unknown>[] = [];
    for (const key of keys) {
      const tail = tails.get(key);
      if (tail) before.push(tail);
    }
    if (!before.length && !needed.length) return host.execute(input);
    const inputGeneration = host.generation();
    const splitBatch = input.type === "agent.events" && needed.length > 0;
    const prepared = Promise.all(before).then(async (): Promise<WorkspaceExecution> => {
      /** Checked again after every read, since the runtime and the screen can both change during one. */
      const refusal = () => {
        if (!host.active(inputGeneration)) return refused(CLOSED);
        if (screen !== undefined && host.screen() !== screen) return refused(MOVED);
        return null;
      };
      const early = refusal();
      if (early) return early;
      if (input.type === "agent.events" && splitBatch) {
        const completions: WorkspaceExecution["completed"][] = [];
        let failure: string | undefined;
        for (const event of input.events) {
          const single = agentEventInput(event);
          try {
            for (const taskId of host.history.needed(single)) await host.history.hydrate(taskId);
            if (!host.active(inputGeneration)) return refused(CLOSED);
            completions.push(host.execute(single).completed);
          } catch (error) {
            if (!host.active(inputGeneration)) return refused(CLOSED);
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
      return refusal() ?? host.execute(input);
    }).catch((error): WorkspaceExecution => {
      if (!host.active(inputGeneration)) return refused(CLOSED);
      const message = errorMessage(error);
      const result = { ok: false as const, message };
      const failed = host.execute({ type: "action.failed", message });
      return { accepted: result, completed: failed.completed.then(() => result) };
    });
    const queued: Promise<unknown> = prepared.finally(() => {
      pending.delete(queued);
      for (const key of keys) if (tails.get(key) === queued) tails.delete(key);
    });
    pending.add(queued);
    for (const key of keys) tails.set(key, queued);
    const completed = prepared.then((execution) => execution.completed);
    if (splitBatch) host.track(completed);
    const accepted = input.type === "agent.events" ? { ok: true as const } : prepared.then((execution) => execution.accepted);
    return { accepted, completed };
  }

  return {
    execute,
    async settled() {
      while (pending.size) await Promise.all([...pending]);
    },
    reset() {
      tails.clear();
      pending.clear();
    },
  };
}
