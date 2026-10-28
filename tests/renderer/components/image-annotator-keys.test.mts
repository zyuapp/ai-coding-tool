import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import { dom, mount, query } from "../../support/renderer-dom.mts";
import type { Annotation } from "../../../src/renderer/annotate/marks.ts";

const pointer = vi.hoisted(() => ({ onBox: (_box: { x: number; y: number; width: number; height: number }) => {} }));
vi.mock("../../../src/renderer/annotate/use-annotator.ts", () => ({
  useAnnotatorImage: () => ({ image: {}, frame: { width: 400, height: 300 } }),
  useMarkPointer: (options: { onBox: typeof pointer.onBox }) => {
    pointer.onBox = options.onBox;
    return { draft: null, handlers: {} };
  },
  usePaintedMarks: () => {},
}));
vi.mock("../../../src/renderer/annotate/marks.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  renderAnnotated: () => "data:image/png;base64,AQID",
}));

const { ImageAnnotator } = await import("../../../src/renderer/components/ImageAnnotator.tsx");

const marks: Annotation[] = [
  { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "First" },
  { kind: "arrow", x: 0.6, y: 0.6, width: 0.2, height: 0.2, text: "" },
];

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

async function open() {
  const calls = { cancelled: 0, applied: [] as Annotation[][] };
  const view = await mount(React.createElement(ImageAnnotator, {
    source: "data:image/png;base64,AQID",
    annotations: marks,
    onCancel: () => { calls.cancelled += 1; },
    onApply: (annotations: Annotation[]) => { calls.applied.push(annotations); },
  }));
  return { view, calls, canvas: query(document.body, ".annotator-frame canvas") };
}

test("arrow keys on the canvas pick a mark, which Delete removes and undo puts back", async () => {
  const { view, calls, canvas } = await open();
  assert.equal(canvas.tabIndex, 0);

  await act(async () => press(canvas, "ArrowRight"));
  assert.ok(query(document.body, '[aria-label="Delete mark 1"]'), "the first mark's tools show");
  await act(async () => press(canvas, "ArrowRight"));
  assert.ok(query(document.body, '[aria-label="Delete arrow"]'), "the next press walks to the arrow");

  await act(async () => press(canvas, "Delete"));
  assert.equal(query(document.body, ".annotator-count").textContent, "1 mark. Point at one to edit or remove it.");
  assert.equal(query<HTMLButtonElement>(document.body, ".annotator-undo").disabled, false);

  await act(async () => press(document.body, "z", { metaKey: true, ctrlKey: true }));
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^2 marks/);
  assert.equal(query<HTMLButtonElement>(document.body, ".annotator-undo").disabled, true);

  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action.primary").click());
  assert.deepEqual(calls.applied, [marks], "undoing every change leaves the marks it opened with");
  await view.unmount();
});

test("closing with changed marks asks first, and closing untouched marks does not", async () => {
  const untouched = await open();
  await act(async () => press(document.body, "Escape"));
  assert.equal(untouched.calls.cancelled, 1);
  await untouched.view.unmount();

  const { view, calls, canvas } = await open();
  await act(async () => press(canvas, "ArrowRight"));
  await act(async () => press(canvas, "Backspace"));
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-close").click());
  assert.equal(calls.cancelled, 0, "the first close only asks");
  assert.match(query(document.body, ".annotator-bar").textContent ?? "", /Discard/);

  await act(async () => press(document.body, "Escape"));
  assert.equal(calls.cancelled, 0, "Escape backs out of discarding");
  assert.ok(query(document.body, ".annotator-undo"), "the usual footer returns");

  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action:not(.primary)").click());
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action.danger").click());
  assert.equal(calls.cancelled, 1);
  await view.unmount();
});

test("B and A pick the tool, but not while a note is being typed", async () => {
  const { view, canvas } = await open();
  const pressed = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".annotator-tool")].find((button) => button.textContent?.includes(label))?.getAttribute("aria-pressed");
  await act(async () => press(document.body, "a"));
  assert.equal(pressed("Arrow"), "true");
  await act(async () => press(document.body, "b"));
  assert.equal(pressed("Box"), "true");

  await act(async () => press(canvas, "ArrowRight"));
  await act(async () => press(canvas, "Enter"));
  const note = query<HTMLInputElement>(document.body, ".annotator-label");
  assert.equal(note.value, "First");
  await act(async () => press(note, "a"));
  assert.equal(pressed("Box"), "true");
  await view.unmount();
});

test("the discard question lands on Keep editing, not on Discard", async () => {
  const { view, canvas } = await open();
  await act(async () => press(canvas, "ArrowRight"));
  await act(async () => press(canvas, "Delete"));
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-close").click());
  assert.equal(document.activeElement?.textContent, "Keep editing");
  await view.unmount();
});

test("a picked mark keeps its tools after the pointer leaves the image", async () => {
  const { view, canvas } = await open();
  await act(async () => press(canvas, "ArrowRight"));
  const frame = query(document.body, ".annotator-frame");
  await act(async () => {
    frame.dispatchEvent(new dom.window.PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    frame.dispatchEvent(new dom.window.PointerEvent("pointerleave", { relatedTarget: document.body }));
  });
  const remove = query(document.body, '[aria-label="Delete mark 1"]');
  assert.ok(remove.dataset.tip, "the tool says what it does");
  assert.ok(query(document.body, '[aria-label="Edit note on mark 1"]').dataset.tip);
  await view.unmount();
});

test("the focused canvas says which keys walk its marks", async () => {
  const { view, canvas } = await open();
  const hint = () => query(document.body, ".annotator-count").textContent ?? "";
  assert.match(hint(), /Point at one/);
  await act(async () => { canvas.focus(); });
  assert.match(hint(), /^2 marks\. Arrow keys pick one/);
  await act(async () => { canvas.blur(); });
  assert.match(hint(), /Point at one/);
  await view.unmount();
});

test("the annotator listens for keys once, however often it redraws", async () => {
  const added = vi.spyOn(document, "addEventListener");
  const { view, canvas } = await open();
  await act(async () => press(canvas, "ArrowRight"));
  await act(async () => press(canvas, "ArrowRight"));
  await act(async () => press(document.body, "a"));
  assert.equal(added.mock.calls.filter(([type]) => type === "keydown").length, 1);
  await act(async () => press(document.body, "b"));
  const pressed = [...document.body.querySelectorAll<HTMLButtonElement>(".annotator-tool")].find((button) => button.textContent?.includes("Box"));
  assert.equal(pressed?.getAttribute("aria-pressed"), "true", "the one listener still sees the latest state");
  added.mockRestore();
  await view.unmount();
});

test("the newest mark shows its tools before anything is pointed at", async () => {
  const { view } = await open();
  assert.ok(query(document.body, '[aria-label="Delete arrow"]'));
  await view.unmount();
});

test("Escape throws away a box just drawn, and Enter keeps it", async () => {
  const drawn = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };
  const { view } = await open();
  await act(async () => pointer.onBox(drawn));
  await act(async () => press(query(document.body, ".annotator-label"), "Escape"));
  assert.equal(document.body.querySelector(".annotator-label"), null);
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^2 marks/);
  assert.equal(query<HTMLButtonElement>(document.body, ".annotator-undo").disabled, true);

  await act(async () => pointer.onBox(drawn));
  await act(async () => press(query(document.body, ".annotator-label"), "Enter"));
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^3 marks/);
  assert.ok(query(document.body, '[aria-label="Delete mark 2"]'), "the kept box is the newest, so its tools show");
  await view.unmount();
});
