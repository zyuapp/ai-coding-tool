import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../../support/renderer-dom.mts";

const { AttachmentViewer } = await import("../../../src/renderer/components/AttachmentViewer.tsx");

/** jsdom fetches nothing, so a test says how big the picture turned out to be. */
async function loaded(width: number, height: number) {
  const image = query<HTMLImageElement>(document, ".viewer-stage img");
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  await act(async () => { image.dispatchEvent(new dom.window.Event("load")); });
  return image;
}

test("a loaded picture exposes zoom controls and resizes its image", async () => {
  const view = await mount(React.createElement(AttachmentViewer, { source: "shot.png", onClose: () => {} }));
  const readout = () => query(document, ".viewer-zoom span").textContent;
  const zoom = (label: string) => query<HTMLButtonElement>(document, `.viewer-zoom button[aria-label="${label}"]`);

  assert.equal(document.querySelector(".viewer-zoom"), null);
  const image = await loaded(800, 400);
  assert.equal(readout(), "100%");
  assert.equal(image.style.width, "800px");
  assert.equal(zoom("Zoom out").disabled, true);

  await act(async () => { zoom("Zoom in").click(); });
  assert.ok(Number.parseInt(readout(), 10) > 100);
  assert.equal(Math.round(Number.parseFloat(image.style.width) / 800 * 100), Number.parseInt(readout(), 10));

  await view.unmount();
});

test("the picture viewer closes on Escape and on the backdrop, but not on a drag off the picture", async () => {
  const closed: string[] = [];
  const view = await mount(React.createElement(AttachmentViewer, { source: "shot.png", onClose: () => closed.push("closed") }));
  const backdrop = query(document, ".viewer.image");
  const image = await loaded(800, 400);
  const press = (target: Element) => target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
  const release = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  await act(async () => { press(image); release(backdrop); });
  assert.deepEqual(closed, []);

  await act(async () => { press(backdrop); release(backdrop); });
  assert.deepEqual(closed, ["closed"]);

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.deepEqual(closed, ["closed", "closed"]);
  await view.unmount();
});
