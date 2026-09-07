import type { TerminalDataEvent, TerminalScreenSnapshot } from "../../contracts/ipc.js";

const MAX_PENDING = 2 * 1024 * 1024;

/** Holds live output until the reload snapshot arrives, then resumes after its sequence watermark. */
export class TerminalOutput {
  private pending: TerminalDataEvent[] = [];
  private pendingSize = 0;
  private overflowed = false;
  private sequence = -1;
  private ready = false;
  private disposed = false;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly snapshot: () => Promise<TerminalScreenSnapshot | null>,
    private readonly restore: (snapshot: TerminalScreenSnapshot) => void,
    private readonly write: (data: string) => void,
  ) {}

  push(event: TerminalDataEvent) {
    if (this.disposed || event.sequence <= this.sequence) return;
    if (this.ready) {
      this.sequence = event.sequence;
      this.write(event.data);
      return;
    }
    if (this.pendingSize + event.data.length > MAX_PENDING) {
      this.pending = [];
      this.pendingSize = 0;
      this.overflowed = true;
      return;
    }
    this.pending.push(event);
    this.pendingSize += event.data.length;
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
      for (const event of this.pending) this.push(event);
      this.pending = [];
      this.pendingSize = 0;
      return;
    } while (!this.disposed);
  }

  dispose() {
    this.disposed = true;
    this.pending = [];
    this.pendingSize = 0;
  }
}
