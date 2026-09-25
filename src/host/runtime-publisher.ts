import { workspacePatches } from "../application/workspace-patches.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceResponse, WorkspaceUpdate } from "../contracts/workspace-runtime.js";
import { errorMessage } from "./errors.js";
import type { WorkspaceRuntime } from "./workspace-runtime.js";

/** One thing that watches the runtime's state: a window, or a paired computer on the other end of a socket. */
export type RuntimeSubscriber = (update: WorkspaceUpdate) => void;

/**
 * Numbers the runtime's states and hands each subscriber the difference between one and the next.
 * Commits that land in one turn are published together, so a run reporting on every tool call
 * costs its watchers one update rather than one per report.
 */
export function createRuntimePublisher(runtime: WorkspaceRuntime) {
  const subscribers = new Set<RuntimeSubscriber>();
  let previous = runtime.getState();
  let revision = 0;
  let publishing = false;

  function publishPending() {
    publishing = false;
    const state = runtime.getState();
    if (state === previous) return;
    const patches = workspacePatches(previous, state);
    previous = state;
    if (!patches.length) return;
    revision += 1;
    for (const subscriber of subscribers) subscriber({ revision, patches });
  }

  const stop = runtime.subscribe(() => {
    if (publishing) return;
    publishing = true;
    queueMicrotask(publishPending);
  });

  /** The whole state as it stands, at the revision the next patch follows. */
  function snapshot(): WorkspaceUpdate {
    publishPending();
    return { revision, state: runtime.getState() };
  }

  return {
    get revision() { return revision; },
    subscribe(subscriber: RuntimeSubscriber) {
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    snapshot,
    /** Runs one input to completion and answers with the revision its effects left the state at. */
    async request(input: WorkspaceInput): Promise<WorkspaceResponse["result"]> {
      try {
        const result = await runtime.execute(input).completed;
        publishPending();
        return { ...result, revision };
      } catch (error) {
        publishPending();
        return { ok: false, message: errorMessage(error), revision };
      }
    },
    /** Waits for every effect in flight and every write behind it, then publishes what they left. */
    async flush(): Promise<WorkspaceResponse["result"]> {
      try {
        await runtime.flush();
        publishPending();
        return { ok: true, revision };
      } catch (error) {
        publishPending();
        return { ok: false, message: errorMessage(error), revision };
      }
    },
    dispose() {
      stop();
      subscribers.clear();
    },
  };
}

export type RuntimePublisher = ReturnType<typeof createRuntimePublisher>;
