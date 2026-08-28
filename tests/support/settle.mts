import assert from "node:assert/strict";
import { act } from "react";

/** Lets the frame a report is waiting on run, since a run's reports reach the window a frame at a time. */
export async function settleFrame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/**
 * Renders until the condition holds. Work that finishes on a chain of promises — reading a file,
 * drawing a QR, saving an attachment — takes as many turns as the machine is busy, so a test that
 * waits a fixed tick passes alone and fails under load.
 */
export async function settleUntil(held: () => boolean, what = "the render never settled") {
  for (let attempt = 0; attempt < 200 && !held(); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert.ok(held(), what);
}
