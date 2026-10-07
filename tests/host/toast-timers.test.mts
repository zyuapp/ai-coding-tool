import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createToastTimers } from "../../src/host/toast-timers.ts";

afterEach(() => { vi.useRealTimers(); });

test("each toast keeps its own time, scheduling one again restarts it, and stopping drops them all", () => {
  vi.useFakeTimers({ now: 0 });
  const elapsed: number[] = [];
  const timers = createToastTimers((id) => elapsed.push(id));
  timers.schedule(1, 5_000);
  timers.schedule(2, 6_000);
  vi.advanceTimersByTime(4_000);
  timers.schedule(1, 9_000);
  vi.advanceTimersByTime(2_000);
  assert.deepEqual(elapsed, [2], "the restarted toast is not taken down at its first time");
  vi.advanceTimersByTime(3_000);
  assert.deepEqual(elapsed, [2, 1]);

  timers.schedule(3, 12_000);
  timers.dispose();
  vi.advanceTimersByTime(10_000);
  assert.deepEqual(elapsed, [2, 1], "a stopped host takes nothing down");
});
