/** What the app did about one thread sitting idle: the run end it answered, and when it started compacting for it. */
export type IdleCompaction = { runEndedAt: number; startedAt?: number };

/** Session-only, so a restart answers every idle thread afresh, and a missed time lets the thread be. */
export type IdleCompactionState = {
  idleCompactions: Record<string, IdleCompaction>;
};

export function initialIdleCompactionState(): IdleCompactionState {
  return { idleCompactions: {} };
}
