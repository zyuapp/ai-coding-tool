import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { WheelSwipe } from "../../src/renderer/simulator/wheel-swipe.ts";

test("a scroll drags a finger against it and lifts it once the scrolling rests", () => {
  vi.useFakeTimers();
  const touches: [string, number, number][] = [];
  const swipe = new WheelSwipe((phase, x, y) => touches.push([phase, Math.round(x * 100) / 100, Math.round(y * 100) / 100]), 100);

  swipe.wheel(0.5, 0.5, 0, 0.01);
  assert.equal(touches.length, 0, "a nudge too small to be a drag lands nothing, so it is never a tap");
  swipe.wheel(0.5, 0.5, 0, 0.03);
  swipe.wheel(0.5, 0.5, 0, 0.1);
  assert.deepEqual(touches, [["down", 0.5, 0.5], ["move", 0.5, 0.46], ["move", 0.5, 0.36]]);
  vi.advanceTimersByTime(100);
  assert.deepEqual(touches.at(-1), ["up", 0.5, 0.36]);

  touches.length = 0;
  swipe.wheel(0.5, 0.1, 0, 0.05);
  swipe.wheel(0.5, 0.1, 0, 0.2);
  assert.deepEqual(touches.map(([phase]) => phase), ["down", "move", "move", "up"], "a finger dragged to the edge lifts at once");
  vi.useRealTimers();
});
