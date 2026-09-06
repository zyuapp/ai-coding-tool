import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, test, vi } from "vitest";
import { useComposerCaret } from "../../../src/renderer/components/composer-caret.ts";
import { NativeSurface, type SurfaceBox } from "../../../src/renderer/components/NativeSurface.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "MutationObserver", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

/** jsdom has neither, and the surface is driven by both. */
class ResizeObserverStub implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
let frames: FrameRequestCallback[] = [];
for (const target of [globalThis, dom.window]) {
  Object.defineProperty(target, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(target, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => frames.push(run) });
  Object.defineProperty(target, "cancelAnimationFrame", { configurable: true, value: () => {} });
}

/** Where the panel has the box now. Only its left edge moves, which is what a slide does to it. */
let left = 600;
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: left, y: 50, width: 400, height: 600, top: 50, left, right: left + 400, bottom: 650, toJSON: () => ({}) }),
});
dom.window.document.elementFromPoint = () => dom.window.document.querySelector(".page");

const nextFrame = async () => {
  const due = frames;
  frames = [];
  await act(async () => { for (const run of due) run(0); });
};

test("the page travels with the panel that carries it rather than waiting out the slide", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const drawn: (SurfaceBox | null)[] = [];
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(NativeSurface, { className: "page", report: (box) => drawn.push(box) })); });
  assert.equal(drawn.at(-1)?.x, 600, "an uncovered box draws the page where it is");

  /** The panel starts sliding away, which moves the box without resizing it. */
  await act(async () => { container.dispatchEvent(new dom.window.Event("transitionrun", { bubbles: true })); });
  left = 800;
  await nextFrame();
  assert.equal(drawn.at(-1)?.x, 800, "the page is drawn where the panel has reached, not where it set off");

  left = 1000;
  await nextFrame();
  assert.equal(drawn.at(-1)?.x, 1000, "and keeps up for every frame of the slide");

  await act(async () => { container.dispatchEvent(new dom.window.Event("transitionend", { bubbles: true })); });
  await nextFrame();
  left = 1200;
  await nextFrame();
  assert.equal(drawn.at(-1)?.x, 1000, "once the panel settles the box stops following it every frame");

  await act(async () => { root.unmount(); });
  assert.equal(drawn.at(-1), null, "an unmounted surface leaves no page drawn over the app");
});

afterAll(() => dom.window.close());

test("a composer focus request focuses its textarea without scrolling", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const focus = vi.spyOn(dom.window.HTMLTextAreaElement.prototype, "focus").mockImplementation(() => {});
  t.onTestFinished(async () => { await act(async () => root.unmount()); focus.mockRestore(); container.remove(); });
  function Composer({ token }: { token: number }) {
    const caret = useComposerCaret(token);
    return React.createElement("textarea", { ref: caret.textareaRef });
  }
  await act(async () => root.render(React.createElement(Composer, { token: 0 })));
  assert.equal(focus.mock.calls.length, 0);
  await act(async () => root.render(React.createElement(Composer, { token: 1 })));
  assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
  assert.equal(focus.mock.instances[0], container.querySelector("textarea"));
});
