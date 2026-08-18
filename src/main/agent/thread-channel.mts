import { randomUUID } from "node:crypto";
import type { ExternalCommand, ThreadCommandResult, ThreadListQuery, ThreadRequest, ThreadResponse, ThreadSummary, ThreadTranscript } from "../../contracts/threads.js";
import type { ThreadBridge } from "./agent-provider.mjs";

/** The request union minus the envelope, distributed so each op keeps its own payload. */
type ThreadRequestPayload = ThreadRequest extends infer Request
  ? Request extends unknown
    ? Omit<Request, "type" | "requestId">
    : never
  : never;

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT = 10_000;

/** Turns the agent process's one-way port into request/response bridges scoped per task. */
export class ThreadChannel {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly post: (request: ThreadRequest) => void,
    private readonly timeout = REQUEST_TIMEOUT,
  ) {}

  bridgeFor(taskId: string): ThreadBridge {
    return {
      list: (query: ThreadListQuery) => this.request({ taskId, op: "list", ...query }) as Promise<ThreadSummary[]>,
      read: (threadId: string, limit?: number) => this.request({ taskId, op: "read", threadId, ...(limit === undefined ? {} : { limit }) }) as Promise<ThreadTranscript>,
      command: (command: ExternalCommand) => this.request({ taskId, op: "command", command }) as Promise<ThreadCommandResult>,
    };
  }

  settle(response: ThreadResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.message));
    return true;
  }

  /** A lost response has to surface as a tool error; a hung tool call reports nothing at all. */
  private request(payload: ThreadRequestPayload) {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Claudex did not answer the thread "${payload.op}" request within ${this.timeout}ms.`));
      }, this.timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.post({ type: "thread.request", requestId, ...payload } as ThreadRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
