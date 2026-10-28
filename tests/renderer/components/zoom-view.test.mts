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
  const readout = () => Number.parseInt(query(view.container, ".viewer-zoom-level").textContent, 10);
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

  const level = () => query<HTMLButtonElement>(view.container, ".viewer-zoom-level");
  assert.equal(level().disabled, true, "a fitted view has nothing to reset");
  await act(async () => { button("in").click(); button("in").click(); });
  assert.ok(readout() > 50);
  await act(async () => { level().click(); });
  assert.equal(readout(), 50, "the readout fits the view again");
});

test("+, − and 0 zoom the open viewer, but not while the keyboard is elsewhere or typing", async (t) => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const field = document.createElement("input");
  const view = await mount(React.createElement(Viewer));
  t.onTestFinished(async () => { await view.unmount(); outside.remove(); });
  const stage = query(view.container, ".stage");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  await act(async () => { fireResizeObservers(); });
  stage.append(field);
  const readout = () => Number.parseInt(query(view.container, ".viewer-zoom-level").textContent, 10);
  const press = async (target: EventTarget, key: string) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };

  assert.equal(readout(), 50);
  assert.equal(await press(document.body, "+"), true);
  assert.ok(readout() > 50, "+ with nothing focused zooms in");
  const zoomed = readout();
  assert.equal(await press(query(view.container, '[aria-label="Zoom in"]'), "="), true);
  assert.ok(readout() > zoomed, "= inside the viewer zooms in too");
  const before = readout();
  assert.equal(await press(document.body, "-"), true);
  assert.ok(readout() < before, "- zooms out");
  assert.equal(await press(document.body, "0"), true);
  assert.equal(readout(), 50, "0 fits the view again");

  assert.equal(await press(outside, "+"), false, "a key pressed on a control outside the viewer is left to it");
  assert.equal(readout(), 50);
  assert.equal(await press(field, "+"), false, "a key typed into a field stays text");
  assert.equal(readout(), 50);
});
