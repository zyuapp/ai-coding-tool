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

test("a picture offers zoom once it has loaded, and its image follows the zoom", async () => {
  const view = await mount(React.createElement(AttachmentViewer, { source: "shot.png", gallery: [], onStep: () => {}, onClose: () => {}, onDownload: () => {} }));
  const readout = () => query(document, ".viewer-zoom-level").textContent;

  assert.equal(document.querySelector(".viewer-zoom"), null);
  const image = await loaded(800, 400);
  assert.equal(image.style.width, "800px");

  await act(async () => { query<HTMLButtonElement>(document, '.viewer-zoom button[aria-label="Zoom in"]').click(); });
  assert.equal(Math.round(Number.parseFloat(image.style.width) / 800 * 100), Number.parseInt(readout(), 10));
  await view.unmount();
});

test("the picture viewer closes on Escape and on the backdrop, but not on a drag off the picture", async () => {
  const closed: string[] = [];
  const downloads: string[] = [];
  const view = await mount(React.createElement(AttachmentViewer, { source: "shot.png", gallery: [], onStep: () => {}, onClose: () => closed.push("closed"), onDownload: () => downloads.push("download") }));
  const backdrop = query(document, ".viewer.image");
  assert.equal(document.querySelector("button[aria-label='Download image']"), null, "nothing is offered for a picture still loading");
  const image = await loaded(800, 400);
  const press = (target: Element) => target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
  const release = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  const download = query<HTMLButtonElement>(document, "button[aria-label='Download image']");
  await act(async () => { press(download); release(download); });
  assert.deepEqual(downloads, ["download"]);
  assert.deepEqual(closed, [], "saving leaves the preview open");

  await act(async () => { press(image); release(backdrop); });
  assert.deepEqual(closed, []);

  await act(async () => { press(backdrop); release(backdrop); });
  assert.deepEqual(closed, ["closed"]);

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.deepEqual(closed, ["closed", "closed"]);
  await view.unmount();
});

test("a picture that is gone says so and offers only closing", async () => {
  const view = await mount(React.createElement(AttachmentViewer, { source: "gone.png", gallery: [], onStep: () => {}, onClose: () => {}, onDownload: () => {} }));
  await act(async () => { query(document, ".viewer-stage img").dispatchEvent(new dom.window.Event("error")); });
  assert.match(query(document, ".viewer-stage [role='status']").textContent, /no longer available/);
  assert.equal(document.querySelector("button[aria-label='Download image']"), null);
  assert.equal(document.querySelector(".viewer-zoom"), null);
  assert.ok(document.querySelector("button[aria-label='Close screenshot']"));
  await view.unmount();
});

test("arrow keys and the side buttons step through a gallery, and do nothing for a lone picture", async () => {
  const steps: number[] = [];
  const props = { gallery: ["a.png", "b.png", "c.png"], onStep: (delta: -1 | 1) => steps.push(delta), onClose: () => {}, onDownload: () => {} };
  const view = await mount(React.createElement(AttachmentViewer, { ...props, source: "a.png" }));
  const key = (name: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const button = (label: string) => query<HTMLButtonElement>(document, `button[aria-label="${label}"]`);

  assert.equal(query(document, ".viewer-count").textContent, "1 / 3");
  assert.equal(button("Previous image").disabled, true);
  await act(async () => { key("ArrowRight"); key("ArrowLeft"); button("Next image").click(); });
  assert.deepEqual(steps, [1, -1, 1]);

  await view.render(React.createElement(AttachmentViewer, { ...props, source: "c.png" }));
  assert.equal(query(document, ".viewer-count").textContent, "3 / 3");
  assert.equal(button("Next image").disabled, true);
  assert.equal(query<HTMLImageElement>(document, ".viewer-stage img").getAttribute("src"), "c.png");

  await view.render(React.createElement(AttachmentViewer, { ...props, gallery: [], source: "c.png" }));
  steps.length = 0;
  await act(async () => { key("ArrowRight"); });
  assert.deepEqual(steps, []);
  assert.equal(document.querySelector(".viewer-step"), null);
  await view.unmount();
});
