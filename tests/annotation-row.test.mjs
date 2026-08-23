import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no ResizeObserver, and the card re-measures its clamp through one. */
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { AnnotationRow } = await vite.ssrLoadModule("/src/renderer/components/AnnotationRow.tsx");

test.after(async () => {
  await vite.close();
  dom.window.close();
});

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const annotations = [
  { id: "a", quote: "const flaky = await agent('grep CI logs')", note: "" },
  { id: "b", quote: "the reducer is the only writer of workspace state", note: "fix the read order" },
];

test("a pill wears the note, and falls back to the quote when no note was taken", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pills = [...view.container.querySelectorAll(".annotation-pill")];

  assert.deepEqual(pills.map((pill) => pill.querySelector(".annotation-pill-number").textContent), ["1", "2"]);
  assert.equal(pills[0].querySelector(".annotation-pill-quote").textContent, "“const flaky = await agent('grep CI logs')");
  assert.equal(pills[0].querySelector(".annotation-card-note").textContent, "No note taken.");
  assert.equal(pills[1].querySelector(".annotation-pill-quote"), null);
  assert.equal(pills[1].querySelector(".annotation-pill-label").textContent, "fix the read order");
  assert.equal(pills[1].querySelector(".annotation-card-quote").textContent, annotations[1].quote);
  await view.unmount();
});

test("a keyboard reaches the card the pointer raises", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pill = view.container.querySelectorAll(".annotation-pill")[1];
  const card = pill.querySelector(".annotation-card");

  assert.equal(pill.getAttribute("tabindex"), "0");
  assert.equal(pill.getAttribute("aria-label"), "Annotation 2");
  assert.equal(pill.getAttribute("aria-describedby"), card.id);
  assert.equal(card.getAttribute("role"), "tooltip");
  await view.unmount();
});

test("a sent annotation keeps its card and loses its remove button", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  assert.equal(view.container.querySelectorAll(".annotation-pill button").length, 2);

  await view.render(React.createElement(AnnotationRow, { annotations }));
  assert.equal(view.container.querySelector(".annotation-pill button"), null);
  assert.equal(view.container.querySelectorAll(".annotation-card").length, 2);

  await view.render(React.createElement(AnnotationRow, { annotations: [] }));
  assert.equal(view.container.querySelector(".annotation-row"), null);
  await view.unmount();
});
