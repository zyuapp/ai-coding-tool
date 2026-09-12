import type { BackgroundReport } from "../../contracts/ipc.js";
import type { BackgroundProcess } from "../../domain/run.js";

/**
 * The work an agent leaves running under a session, which outlives the turn that started it. Engines
 * report it as a level rather than as start and finish bookends, so the whole set is swapped for each
 * report: a bookend never seen, or seen twice, cannot leave the session holding work that has stopped.
 */
export class BackgroundWork {
  private ids = new Set<string>();
  private report: (report: BackgroundReport) => void = () => {};

  /** `busy` speaks for the whole session: work stopping is rest only when nothing else is going. */
  constructor(private readonly busy: () => boolean, private readonly rested: () => void) {}

  /** Whether work that closing the session would cut short is still running. */
  get running() {
    return this.ids.size > 0;
  }

  /** A fresh process has nothing running under it, so the thread's set starts empty. */
  openWith(report: (report: BackgroundReport) => void) {
    this.report = report;
    this.clear();
  }

  /**
   * Swaps the whole set. `ids` names the work that keeps the session busy, which is wider than what
   * is reported when the engine runs work of its own through the same mechanism.
   */
  replace(processes: BackgroundProcess[], ids: readonly string[] = processes.map((process) => process.id)) {
    const wasRunning = this.running;
    this.ids = new Set(ids);
    this.report({ type: "background.changed", processes });
    if (wasRunning && !this.busy()) this.rested();
  }

  /** The session ending is the end of the work it holds: nothing is left to report it stopping. */
  clear() {
    this.ids.clear();
    this.report({ type: "background.changed", processes: [] });
  }
}
