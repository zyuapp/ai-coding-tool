import type { TerminalDataEvent } from "../contracts/terminal.js";

const MAX_BYTES = 1024 * 1024;
const MAX_CHUNKS = 128;

/** A bounded tail shared by remote viewers. A reader that falls behind restores the screen. */
export class TerminalOutputBuffer {
  private chunks: TerminalDataEvent[] = [];
  private bytes = 0;
  private listeners = new Set<() => void>();

  push(event: TerminalDataEvent) {
    this.chunks.push(event);
    this.bytes += event.data.length;
    while (this.bytes > MAX_BYTES || this.chunks.length > MAX_CHUNKS) {
      this.bytes -= this.chunks.shift()!.data.length;
    }
    this.wake();
  }

  read(after: number, sequence: number): string | null {
    if (after === sequence) return "";
    if (after > sequence || !this.chunks.length || after < this.chunks[0].sequence - 1) return null;
    return this.chunks.filter((chunk) => chunk.sequence > after).map((chunk) => chunk.data).join("");
  }

  /** A short deadline releases reads for hidden tabs without holding a socket query indefinitely. */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 1_000);
      timer.unref?.();
      this.listeners.add(done);
    });
  }

  wake() {
    for (const done of this.listeners) done();
  }

  reset() {
    this.chunks = [];
    this.bytes = 0;
    this.wake();
  }
}
