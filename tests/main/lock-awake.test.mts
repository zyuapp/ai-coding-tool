import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { startLockAwake, type LockMonitor, type SleepBlocker } from "../../src/main/lock-awake.js";
import { startMainProcess } from "../support/electron-harness.mjs";

class FakeLockMonitor extends EventEmitter implements LockMonitor {
  constructor(private state: ReturnType<LockMonitor["getSystemIdleState"]> = "active") {
    super();
  }

  getSystemIdleState() {
    return this.state;
  }
}

class FakeSleepBlocker implements SleepBlocker {
  readonly started: Array<{ id: number; type: "prevent-app-suspension" }> = [];
  readonly stopped: number[] = [];
  private readonly active = new Set<number>();

  start(type: "prevent-app-suspension") {
    const id = this.started.length + 1;
    this.started.push({ id, type });
    this.active.add(id);
    return id;
  }

  stop(id: number) {
    this.stopped.push(id);
    return this.active.delete(id);
  }

  isStarted(id: number) {
    return this.active.has(id);
  }
}

test("a locked screen keeps the app awake until the screen unlocks", () => {
  const monitor = new FakeLockMonitor();
  const blocker = new FakeSleepBlocker();
  const awake = startLockAwake(monitor, blocker);

  monitor.emit("lock-screen");
  monitor.emit("lock-screen");
  assert.deepEqual(blocker.started, [{ id: 1, type: "prevent-app-suspension" }]);

  monitor.emit("unlock-screen");
  monitor.emit("unlock-screen");
  assert.deepEqual(blocker.stopped, [1]);

  awake.stop();
});

test("startup and shutdown handle a screen that is already locked", () => {
  const monitor = new FakeLockMonitor("locked");
  const blocker = new FakeSleepBlocker();
  const awake = startLockAwake(monitor, blocker);

  assert.deepEqual(blocker.started, [{ id: 1, type: "prevent-app-suspension" }]);

  awake.stop();
  awake.stop();
  monitor.emit("lock-screen");
  assert.deepEqual(blocker.stopped, [1]);
  assert.equal(blocker.started.length, 1);
});

test("unlock leaves another sleep request active", () => {
  const monitor = new FakeLockMonitor();
  const blocker = new FakeSleepBlocker();
  const phoneRequest = blocker.start("prevent-app-suspension");
  const awake = startLockAwake(monitor, blocker);

  monitor.emit("lock-screen");
  monitor.emit("unlock-screen");

  assert.deepEqual(blocker.stopped, [2]);
  assert.equal(blocker.isStarted(phoneRequest), true);
  awake.stop();
});

test("the macOS app starts and stops the lock sleep request", { skip: process.platform !== "darwin" }, async (context) => {
  const main = await startMainProcess(context, "aicodingtool-lock-awake-");

  main.powerMonitor.emit("lock-screen");
  assert.deepEqual(main.powerBlockerStarts, [{ id: 1, type: "prevent-app-suspension" }]);

  main.powerMonitor.emit("unlock-screen");
  assert.deepEqual(main.powerBlockerStops, [1]);

  main.powerMonitor.emit("lock-screen");
  await main.dispose();
  assert.deepEqual(main.powerBlockerStops, [1, 2]);
});
