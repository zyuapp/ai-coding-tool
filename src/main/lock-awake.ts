export type LockMonitor = {
  on(event: "lock-screen" | "unlock-screen", listener: () => void): unknown;
  off(event: "lock-screen" | "unlock-screen", listener: () => void): unknown;
  getSystemIdleState(idleThreshold: number): "active" | "idle" | "locked" | "unknown";
};

export type SleepBlocker = {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
};

export type LockAwake = {
  stop(): void;
};

/** Lets the display lock and turn off while the app and its work continue to run. */
export function startLockAwake(monitor: LockMonitor, blocker: SleepBlocker): LockAwake {
  let blockerId: number | null = null;

  function lock() {
    if (blockerId !== null) return;
    blockerId = blocker.start("prevent-app-suspension");
  }

  function unlock() {
    if (blockerId === null) return;
    if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
    blockerId = null;
  }

  monitor.on("lock-screen", lock);
  monitor.on("unlock-screen", unlock);
  if (monitor.getSystemIdleState(1) === "locked") lock();

  return {
    stop() {
      monitor.off("lock-screen", lock);
      monitor.off("unlock-screen", unlock);
      unlock();
    },
  };
}
