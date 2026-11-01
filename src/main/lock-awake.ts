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
  /** Looks at the work again, after it may have started or finished. */
  update(): void;
  stop(): void;
};

/**
 * Lets the display lock and turn off while the app's work continues to run. The Mac may idle-sleep
 * once the screen is locked and nothing is left to do, so a quiet app never drains the battery.
 */
export function startLockAwake(monitor: LockMonitor, blocker: SleepBlocker, working: () => boolean = () => true): LockAwake {
  let blockerId: number | null = null;
  let locked = false;

  function hold() {
    if (blockerId !== null) return;
    blockerId = blocker.start("prevent-app-suspension");
  }

  function release() {
    if (blockerId === null) return;
    if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
    blockerId = null;
  }

  function update() {
    if (locked && working()) hold();
    else release();
  }

  function lock() {
    locked = true;
    update();
  }

  function unlock() {
    locked = false;
    release();
  }

  monitor.on("lock-screen", lock);
  monitor.on("unlock-screen", unlock);
  if (monitor.getSystemIdleState(1) === "locked") lock();

  return {
    update() { if (locked) update(); },
    stop() {
      monitor.off("lock-screen", lock);
      monitor.off("unlock-screen", unlock);
      unlock();
    },
  };
}
