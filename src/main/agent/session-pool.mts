import { continuationOf, type ProviderResult, type ProviderRunInput } from "./agent-provider.mjs";

/** How long a thread's session waits, with nothing left running under it, before giving its process back. */
const IDLE_SESSION_MS = 15 * 60 * 1_000;
/** How many threads keep a session warm. Beyond this the least recently used idle one is let go. */
const MAX_LIVE_SESSIONS = 4;

/** What the pool asks of a session, whichever engine it runs on. */
export type PooledSession = {
  readonly key: string;
  readonly live: boolean;
  /** Anything closing the session would cut short. */
  readonly busy: boolean;
  /** A turn is in flight, so the session owes an answer before it can take another. */
  readonly answering: boolean;
  continues(continuation: string | undefined): boolean;
  run(input: ProviderRunInput): Promise<ProviderResult>;
  close(): void;
};

/** What a session is built with: `ended` forgets it, `rested` restarts its idle clock. */
export type SessionHooks = { ended(): void; rested(): void };

export type SessionOpener<S extends PooledSession> = {
  open(hooks: SessionHooks): S;
  /** Runs once the pool holds the session, so a session that ends at once is already known to it. */
  start?(session: S): void;
};

type Held = {
  session: PooledSession;
  usedAt: number;
  idle?: ReturnType<typeof setTimeout>;
};

/**
 * One warm session per thread: the process it holds is what makes a second turn cheap. Engines
 * share one pool, so the cap bounds their processes together.
 */
export class SessionPool {
  private readonly sessions = new Map<string, Held>();

  constructor(private readonly idleMs: number = IDLE_SESSION_MS) {}

  /** Runs on the thread's session where it fits the run, and on a fresh one otherwise. */
  async execute<S extends PooledSession>(input: ProviderRunInput, key: string, opener: SessionOpener<S>): Promise<ProviderResult> {
    const held = this.sessionFor(input, key, opener);
    try {
      return await held.session.run(input);
    } finally {
      this.rest(input.taskId, held);
    }
  }

  /** The thread's session, while it is live. */
  liveSession(taskId: string): PooledSession | undefined {
    const held = this.sessions.get(taskId);
    return held?.session.live ? held.session : undefined;
  }

  /** Lets every session go, which is what ends the processes they hold. */
  closeAll() {
    for (const held of [...this.sessions.values()]) {
      clearTimeout(held.idle);
      held.session.close();
    }
    this.sessions.clear();
  }

  private sessionFor<S extends PooledSession>(input: ProviderRunInput, key: string, opener: SessionOpener<S>): Held {
    const held = this.sessions.get(input.taskId);
    const reusable = held?.session.live
      && held.session.key === key
      && !held.session.answering
      && !input.forkContinuation
      && held.session.continues(continuationOf(input));
    if (held && reusable) {
      clearTimeout(held.idle);
      held.idle = undefined;
      held.usedAt = Date.now();
      return held;
    }
    if (held) this.release(input.taskId, held);
    this.evict();
    const session = opener.open({
      ended: () => {
        if (this.sessions.get(input.taskId)?.session === session) this.sessions.delete(input.taskId);
      },
      rested: () => {
        const settled = this.sessions.get(input.taskId);
        if (settled?.session === session) this.rest(input.taskId, settled);
      },
    });
    const opened: Held = { session, usedAt: Date.now() };
    this.sessions.set(input.taskId, opened);
    opener.start?.(session);
    return opened;
  }

  /**
   * A session with nothing left to do is kept warm for a while, then handed back. Work the agent left
   * running is not nothing: the deadline finds the session busy and starts over, so a workflow that runs
   * for hours is never on a clock, and the session it holds is still reclaimed once the work stops.
   */
  private rest(taskId: string, held: Held) {
    if (this.sessions.get(taskId) !== held || !held.session.live) return;
    held.usedAt = Date.now();
    clearTimeout(held.idle);
    held.idle = setTimeout(() => (held.session.busy ? this.rest(taskId, held) : this.release(taskId, held)), this.idleMs);
    held.idle.unref?.();
  }

  private release(taskId: string, held: Held) {
    clearTimeout(held.idle);
    if (this.sessions.get(taskId) === held) this.sessions.delete(taskId);
    held.session.close();
  }

  private evict() {
    const idle = [...this.sessions].filter(([, held]) => !held.session.busy).sort(([, left], [, right]) => left.usedAt - right.usedAt);
    for (let over = this.sessions.size - MAX_LIVE_SESSIONS + 1; over > 0 && idle.length; over -= 1) {
      const [taskId, held] = idle.shift()!;
      this.release(taskId, held);
    }
  }
}
