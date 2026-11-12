import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { WheelPinch, type PinchFingers } from "../../src/renderer/simulator/wheel-pinch.ts";

test("a trackpad pinch spreads two fingers around the pointer, keeps them on the screen, and lifts them once it rests", () => {
  vi.useFakeTimers();
  const touches: [string, PinchFingers][] = [];
  const pinch = new WheelPinch((phase, fingers) => touches.push([phase, fingers]), 100);
  const spread = (fingers: PinchFingers) => fingers.x2 - fingers.x;

  pinch.pinch(0.5, 0.4, 0);
  const landed = spread(touches[0]![1]);
  pinch.pinch(0.5, 0.4, -50);
  assert.ok(spread(touches.at(-1)![1]) > landed, "spreading the trackpad spreads the fingers");
  pinch.pinch(0.5, 0.4, 100);
  pinch.pinch(0.5, 0.4, 100);
  assert.ok(spread(touches.at(-1)![1]) < landed, "closing the trackpad closes them");
  for (let index = 0; index < 40; index += 1) pinch.pinch(0.5, 0.4, -100);
  const wide = touches.at(-1)![1];
  assert.ok(wide.x >= 0 && wide.x2 <= 1, "the fingers never leave the screen");
  assert.equal((wide.x + wide.x2) / 2, 0.5, "they stay around where the pinch began");
  assert.deepEqual(touches.map(([phase]) => phase).slice(0, 2), ["down", "move"]);

  vi.advanceTimersByTime(100);
  assert.equal(touches.at(-1)![0], "up");

  for (const edge of [0, 0.02, 1]) {
    touches.length = 0;
    pinch.pinch(edge, 0.4, 0);
    pinch.pinch(edge, 0.4, -50);
    pinch.lift();
    assert.ok(touches.every(([, fingers]) => fingers.x >= 0 && fingers.x2 <= 1), `a pinch begun at ${edge} keeps both fingers on the screen`);
    assert.ok(spread(touches.at(-1)![1]) > spread(touches[0]![1]), `a pinch begun at ${edge} still spreads`);
  }
  vi.useRealTimers();
});
