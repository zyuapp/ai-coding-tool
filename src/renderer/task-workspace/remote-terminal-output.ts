import type { TerminalOutputRead } from "../../contracts/terminal.js";

/** Reads only while a remote terminal is visible. Neither retries nor reconnections send input. */
export class RemoteTerminalOutput {
  private generation = 0;
  private status: (error: string | null) => void = () => {};
  live = false;

  constructor(
    private readonly read: (after?: number) => Promise<TerminalOutputRead | null>,
    private readonly draw: (read: TerminalOutputRead) => Promise<void>,
  ) {}

  start(status: (error: string | null) => void) {
    this.stop();
    this.status = status;
    this.status("Connecting…");
    void this.follow(this.generation);
  }

  stop() {
    this.generation += 1;
    this.live = false;
  }

  private async follow(generation: number) {
    let after: number | undefined;
    while (generation === this.generation) {
      try {
        const read = await this.read(after);
        if (generation !== this.generation) return;
        if (!read) { this.live = false; this.status("This terminal has closed."); return; }
        if (read.kind === "snapshot") this.live = false;
        await this.draw(read);
        if (generation !== this.generation) return;
        after = read.sequence;
        this.live = true;
        this.status(null);
      } catch (error) {
        if (generation !== this.generation) return;
        this.live = false;
        this.status(error instanceof Error ? error.message : String(error));
        after = undefined;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
