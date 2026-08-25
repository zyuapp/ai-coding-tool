import { randomUUID } from "node:crypto";
import type { MobileCommand, MobileRequest, MobileResponse, MobileView } from "../../contracts/mobile.js";

/** Shorter than a phone's own patience, so a lost answer comes back as a refusal rather than a hang. */
export const MOBILE_REQUEST_TIMEOUT = 8_000;

type Pending = {
  settle: (response: MobileResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MobileRelayHost = {
  /** Hands one request to the window. False when there is no window to hand it to. */
  send(request: MobileRequest): boolean;
};

function isView(value: unknown): value is MobileView {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  return Array.isArray(view.groups) && (view.thread === null || (Boolean(view.thread) && typeof view.thread === "object"));
}

/**
 * The window holds workspace state, so a phone's command is relayed to it and its answer comes back
 * here, the way the agent's thread requests already travel. Nothing is answered in this process: a
 * request the window never answers times out rather than being quietly dropped, because a phone
 * waiting on an acknowledgement it will never get looks the same as a Mac that has stopped working.
 */
export class MobileRelay {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly host: MobileRelayHost, private readonly patience = MOBILE_REQUEST_TIMEOUT) {}

  async snapshot(sessionId: string): Promise<MobileView> {
    const response = await this.ask({ type: "mobile.request", requestId: randomUUID(), sessionId, op: "snapshot" });
    if (!response.ok) throw new Error(response.message);
    if (!isView(response.result)) throw new Error("The AI Coding Tool window sent an unreadable view.");
    return response.result;
  }

  async command(sessionId: string, command: MobileCommand): Promise<void> {
    const response = await this.ask({ type: "mobile.request", requestId: randomUUID(), sessionId, op: "command", command });
    if (!response.ok) throw new Error(response.message);
  }

  /** The window's answer to one request. An answer to nothing pending is a late one, and is dropped. */
  answer(response: MobileResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.settle(response);
  }

  /** Every waiting request gives up at once, which is what a window that has gone means for all of them. */
  failAll(message: string) {
    for (const [requestId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.settle({ type: "mobile.response", requestId, ok: false, message });
    }
  }

  private ask(request: MobileRequest): Promise<MobileResponse> {
    return new Promise<MobileResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve({ type: "mobile.response", requestId: request.requestId, ok: false, message: `AI Coding Tool did not answer the phone's "${request.op}" within ${this.patience}ms.` });
      }, this.patience);
      timer.unref?.();
      this.pending.set(request.requestId, { settle: resolve, timer });
      if (this.host.send(request)) return;
      this.answer({ type: "mobile.response", requestId: request.requestId, ok: false, message: "The AI Coding Tool window is not open." });
    });
  }
}
