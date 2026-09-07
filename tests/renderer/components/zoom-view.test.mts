import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, fireResizeObservers, mount, query } from "../../support/renderer-dom.mts";

const { useZoom, ZoomControls } = await import("../../../src/renderer/components/ZoomView.tsx");

function Viewer() {
  const zoom = useZoom({ width: 800, height: 400 });
  return React.createElement("div", { ref: zoom.stage, className: "stage" },
    React.createElement(ZoomControls, { zoom }),
  );
}

test("zoom fits the content, bounds buttons and pinches, and leaves ordinary scrolling alone", async (t) => {
  const view = await mount(React.createElement(Viewer));
  t.onTestFinished(() => view.unmount());
  const stage = query(view.container, ".stage");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  await act(async () => { fireResizeObservers(); });
  const readout = () => Number.parseInt(query(view.container, ".viewer-zoom span").textContent, 10);
  const button = (direction: string) => query<HTMLButtonElement>(view.container, `[aria-label="Zoom ${direction}"]`);
  assert.equal(readout(), 50, "oversized content starts fitted to the stage");
  assert.equal(button("out").disabled, true);

  for (const [direction, bound] of [["in", 400], ["out", 50]] as const) {
    for (let step = 0; step < 20 && !button(direction).disabled; step += 1) {
      const before = readout();
      await act(async () => { button(direction).click(); });
      assert.ok(direction === "in" ? readout() > before : readout() < before);
      assert.ok(readout() >= 50 && readout() <= 400);
    }
    assert.equal(readout(), bound);
    assert.equal(button(direction).disabled, true);
  }

  const wheel = async (ctrlKey: boolean, deltaY: number) => {
    const event = new dom.window.WheelEvent("wheel", { ctrlKey, deltaY, bubbles: true, cancelable: true });
    await act(async () => { stage.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, ctrlKey);
  };
  await wheel(true, -50);
  assert.ok(readout() > 50 && readout() < 400, "a pinch scales continuously");
  const pinched = readout();
  await wheel(false, -50);
  assert.equal(readout(), pinched);
  await wheel(true, -1000);
  assert.equal(readout(), 400);
  await wheel(true, 1000);
  assert.equal(readout(), 50);
});
