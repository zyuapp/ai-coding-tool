import type { Continuation } from "../../domain/run.js";
import type { ProviderResult, ProviderRunInput } from "./agent-provider.mjs";
import { OpenFailure, reasonOf } from "./session-common.mjs";

/** What every turn carries, whichever engine answers it: the run that asked, and how it is answered. */
export type SessionTurn = {
  input: ProviderRunInput;
  settle: (result: ProviderResult) => void;
  /** Lets go of what is held for this turn alone. Runs once, as the turn settles. */
  release: () => void;
};

/** How an engine takes a turn: what it adds to it, how it starts it, and how it cuts it short. */
export type TurnEngine<T extends SessionTurn> = {
  open(base: SessionTurn): T;
  begin(turn: T): void;
  interrupt(turn: T): void;
};

/**
 * The one turn a session answers at a time. A cancelled run interrupts the engine rather than
 * answering for it, so the engine's own result still ends the turn; an interrupt that goes
 * unanswered for the grace period gives the session up instead.
 */
export class TurnSlot<T extends SessionTurn> {
  private current: T | null = null;
  private announced = false;

  constructor(private readonly graceMs: number, private readonly abandon: () => void) {}

  /** A turn is in flight, so the session owes an answer before it can take another. */
  get answering() {
    return this.current !== null;
  }

  /** The turn in flight, and nothing between turns. */
  get turn() {
    return this.current;
  }

  /** Takes the turn a run asked for, and answers it with the result the engine settles on. */
  take(input: ProviderRunInput, engine: TurnEngine<T>): Promise<ProviderResult> {
    return new Promise<ProviderResult>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const interrupt = () => {
        engine.interrupt(turn);
        grace = setTimeout(() => {
          this.settle({ status: "cancelled" });
          this.abandon();
        }, this.graceMs);
        grace.unref?.();
      };
      const turn = engine.open({
        input,
        settle: resolve,
        release: () => {
          clearTimeout(grace);
          input.abortController.signal.removeEventListener("abort", interrupt);
        },
      });
      /** The turn is the session's before anything is awaited, so a session that ends still answers it. */
      this.current = turn;
      if (input.abortController.signal.aborted) {
        this.settle({ status: "cancelled" });
        return;
      }
      input.abortController.signal.addEventListener("abort", interrupt, { once: true });
      engine.begin(turn);
    });
  }

  /**
   * Waits on the session's opening for the turn. One that cannot open fails the turn, saying so when
   * the continuation itself is gone, and leaves the session for the caller to close.
   */
  async opened(turn: T, opening: Promise<void>, failure: (error: unknown) => string): Promise<boolean> {
    try {
      await opening;
      return true;
    } catch (error) {
      if (this.current === turn) {
        if (error instanceof OpenFailure && error.lost) turn.input.emit({ type: "continuation-lost" });
        this.settle({ status: "failed", message: failure(error) });
      }
      return false;
    }
  }

  /** Reports the session's handle to the turn in flight. Once is enough: the handle never changes. */
  announce(continuation: Continuation) {
    if (this.announced || !this.current) return;
    this.announced = true;
    this.current.input.emit({ type: "continuation", continuation });
  }

  /** Answers the turn in flight, once. A run the user cancelled is cancelled whatever the engine says. */
  settle(result: ProviderResult) {
    const turn = this.current;
    if (!turn) return;
    this.current = null;
    turn.release();
    turn.settle(turn.input.abortController.signal.aborted ? { status: "cancelled" } : result);
  }
}

/**
 * Feeds a run's steered messages into its turn for as long as `target` finds the turn going. One the
 * engine refuses stays queued on the thread, which sends it as the next turn once the run settles.
 */
export async function drainSteering<C>(input: ProviderRunInput, target: () => C | undefined, steer: (into: C, prompt: string) => Promise<void>, reason: (error: unknown) => string = reasonOf) {
  for (let next = await input.steering.next(); next; next = await input.steering.next()) {
    const into = target();
    if (into === undefined) return;
    try {
      await steer(into, next.prompt);
      input.emit({ type: "steered", messageId: next.messageId });
    } catch (error) {
      if (target() === undefined) return;
      input.emit({ type: "steer-failed", messageId: next.messageId, message: `Could not steer: ${reason(error)}. Your message is still queued for the next turn.` });
    }
  }
}

/** What a turn keeps of a compaction going under it. */
export type Compacting = { compacting?: boolean; compactionPreTokens?: number };

/**
 * Says whether the turn is compacting, measured from the context before it began: what a manual
 * compaction was told, or what the session last read. A repeat says nothing unless it carries an error.
 */
export function reportCompacting(turn: SessionTurn & Compacting, compacting: boolean, lastTokens: number, error?: string) {
  if (compacting && turn.compactionPreTokens === undefined) {
    turn.compactionPreTokens = turn.input.operation?.type === "compact" ? turn.input.operation.preTokens : lastTokens;
  }
  if (turn.compacting === compacting && error === undefined) return;
  turn.compacting = compacting;
  turn.input.emit({ type: "compaction-status", compacting, ...(error ? { error } : {}) });
}
