import type { ProviderResult, ProviderRunInput } from "./agent-provider.mjs";

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

  /** Answers the turn in flight, once. A run the user cancelled is cancelled whatever the engine says. */
  settle(result: ProviderResult) {
    const turn = this.current;
    if (!turn) return;
    this.current = null;
    turn.release();
    turn.settle(turn.input.abortController.signal.aborted ? { status: "cancelled" } : result);
  }
}
