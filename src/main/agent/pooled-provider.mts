import type { CoordinationRole } from "../../domain/coordination.js";
import type { ProviderResult, ProviderRunInput } from "./agent-provider.mjs";
import type { PooledSession, SessionOpener, SessionPool } from "./session-pool.mjs";

/**
 * What every engine's provider shares: the pool its threads' sessions are kept warm in, each read
 * back as the engine's own, and the filings that hold a thread while it is archived or restored.
 */
export abstract class PooledProvider<S extends PooledSession> {
  /** The last filing asked of each thread, so an archive and a restore land in the order given and a run waits for both. */
  private readonly filings = new Map<string, Promise<void>>();

  protected constructor(protected readonly pool: SessionPool, private readonly kind: abstract new (...args: never[]) => S) {}

  retireOutOfRole(taskId: string, role: CoordinationRole | undefined) {
    void this.pool.retireOutOfRole(taskId, role);
  }

  closeAll() {
    this.pool.closeAll();
  }

  /** Runs on the thread's session. A thread still being filed away or brought back is held by that filing until it lands. */
  protected run(input: ProviderRunInput, key: string, opener: SessionOpener<S>): Promise<ProviderResult> {
    const filing = this.filings.get(input.taskId);
    return filing ? filing.then(() => this.pool.execute(input, key, opener)) : this.pool.execute(input, key, opener);
  }

  /** The thread's live session, when this engine opened it. */
  protected session(taskId: string): S | undefined {
    const session = this.pool.liveSession(taskId);
    return session instanceof this.kind ? session : undefined;
  }

  /** Files the thread after its last filing has landed. A filing that fails changes nothing, and holds nothing up. */
  protected file(taskId: string, filing: () => Promise<void>) {
    const queued = (this.filings.get(taskId) ?? Promise.resolve())
      .then(filing)
      .catch(() => {})
      .finally(() => { if (this.filings.get(taskId) === queued) this.filings.delete(taskId); });
    this.filings.set(taskId, queued);
  }
}
