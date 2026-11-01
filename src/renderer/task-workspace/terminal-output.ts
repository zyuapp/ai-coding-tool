import type { TerminalDataEvent, TerminalScreenSnapshot } from "../../contracts/ipc.js";

const MAX_PENDING = 2 * 1024 * 1024;
/** Past this much held output, a suspended view reloads from a snapshot rather than replaying it. */
const MAX_SUSPENDED = 256 * 1024;

/**
 * Holds live output until the reload snapshot arrives, then resumes after its sequence watermark.
 * A suspended view holds output too, so nobody parses or draws what nobody can see.
 */
export class TerminalOutput {
  private pending: TerminalDataEvent[] = [];
  private pendingSize = 0;
  private overflowed = false;
  private sequence = -1;
  private ready = false;
  private suspended = false;
  private disposed = false;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly snapshot: () => Promise<TerminalScreenSnapshot | null>,
    private readonly restore: (snapshot: TerminalScreenSnapshot) => void,
    private readonly write: (data: string, size?: TerminalDataEvent["size"]) => void,
  ) {}

  push(event: TerminalDataEvent) {
    if (this.disposed || event.sequence <= this.sequence) return;
    if (this.ready && !this.suspended) {
      this.sequence = event.sequence;
      this.write(event.data, event.size);
      return;
    }
    if (this.pendingSize + event.data.length > (this.ready ? MAX_SUSPENDED : MAX_PENDING)) {
      this.pending = [];
      this.pendingSize = 0;
      this.overflowed = true;
      return;
    }
    this.pending.push(event);
    this.pendingSize += event.data.length;
  }

  suspend() {
    this.suspended = true;
  }

  /** Replays what was held, or reloads from a snapshot when too much was held to keep. */
  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    if (!this.ready) return;
    if (this.overflowed) {
      this.ready = false;
      void this.start().catch(() => undefined);
      return;
    }
    this.flush();
  }

  start(): Promise<void> {
    if (this.ready || this.disposed) return Promise.resolve();
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load() {
    do {
      this.overflowed = false;
      const snapshot = await this.snapshot();
      if (this.disposed) return;
      if (this.overflowed) continue;
      if (snapshot) {
        this.restore(snapshot);
        this.sequence = snapshot.sequence;
      }
      this.ready = true;
      this.flush();
      return;
    } while (!this.disposed);
  }

  private flush() {
    const events = this.pending;
    this.pending = [];
    this.pendingSize = 0;
    for (const event of events) {
      if (event.sequence <= this.sequence) continue;
      this.sequence = event.sequence;
      this.write(event.data, event.size);
    }
  }

  dispose() {
    this.disposed = true;
    this.pending = [];
    this.pendingSize = 0;
  }
}
