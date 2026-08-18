import { randomUUID } from "node:crypto";
import type { AutomationRequest, AutomationResponse } from "../../contracts/ipc.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { AutomationBridge } from "./agent-provider.mjs";

/** The request union minus the envelope, distributed so each op keeps its own payload. */
type AutomationRequestPayload = AutomationRequest extends infer Request
  ? Request extends unknown
    ? Omit<Request, "type" | "requestId">
    : never
  : never;

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/** Turns the agent process's one-way port into request/response bridges scoped per task. */
export class AutomationChannel {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly post: (request: AutomationRequest) => void) {}

  bridgeFor(taskId: string): AutomationBridge {
    return {
      read: () => this.request({ taskId, op: "read" }) as Promise<AutomationView | null>,
      list: () => this.request({ taskId, op: "list" }) as Promise<AutomationView[]>,
      save: (draft: Omit<AutomationDraft, "taskId">) => this.request({ taskId, op: "save", draft }) as Promise<AutomationView>,
      update: (patch: AutomationPatch) => this.request({ taskId, op: "update", patch }) as Promise<AutomationView>,
      remove: () => this.request({ taskId, op: "delete" }) as Promise<boolean>,
    };
  }

  settle(response: AutomationResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.message));
    return true;
  }

  private request(payload: AutomationRequestPayload) {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.post({ type: "automation.request", requestId, ...payload } as AutomationRequest);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
