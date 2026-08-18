import type { SteerMessage, SteerQueue } from "./agent-provider.mjs";

/**
 * Carries steered messages from the coordinator into the run that is already going. The coordinator
 * pushes; the provider pulls them into the session's input stream.
 */
export class SteerChannel implements SteerQueue {
  private readonly waiting: SteerMessage[] = [];
  private pull: ((message: SteerMessage | null) => void) | null = null;
  private closed = false;

  push(message: SteerMessage) {
    if (this.closed) return false;
    const pull = this.pull;
    if (pull) {
      this.pull = null;
      pull(message);
    } else {
      this.waiting.push(message);
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pull?.(null);
    this.pull = null;
  }

  next(): Promise<SteerMessage | null> {
    const queued = this.waiting.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => { this.pull = resolve; });
  }
}
