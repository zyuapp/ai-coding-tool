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

const { ImageAnnotator, markBounds } = await import("../../../src/renderer/components/ImageAnnotator.tsx");

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
  assert.ok(query(document.body, '.annotator-marktools.picked [aria-label="Delete mark 1"]'), "the first mark's tools show in full");
  await act(async () => press(canvas, "ArrowRight"));
  assert.ok(query(document.body, '.annotator-marktools.picked [aria-label="Delete arrow"]'), "the next press walks to the arrow");

  await act(async () => press(canvas, "Delete"));
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^1 mark\./);
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

test("the footer names the keys that walk the marks only while the canvas has focus", async () => {
  const { view, canvas } = await open();
  assert.equal(query(document.body, ".annotator-count").textContent, "2 marks.");
  await act(async () => { (canvas as HTMLCanvasElement).focus(); });
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^2 marks\. Arrow keys pick one/);
  await act(async () => { (canvas as HTMLCanvasElement).blur(); });
  assert.equal(query(document.body, ".annotator-count").textContent, "2 marks.");
  await view.unmount();
});

test("the picked mark carries a ring around its bounds, and none while a note is typed", async () => {
  const { view, canvas } = await open();
  await act(async () => press(canvas, "ArrowRight"));
  const ring = query<HTMLElement>(document.body, ".annotator-picked");
  assert.deepEqual([ring.style.left, ring.style.top, ring.style.width, ring.style.height], ["40px", "30px", "80px", "60px"]);
  assert.equal(ring.previousElementSibling?.tagName, "CANVAS", "the ring follows the canvas, which reveals it on keyboard focus");

  await act(async () => press(canvas, "Enter"));
  assert.equal(document.body.querySelector(".annotator-picked"), null);
  await view.unmount();
});

test("every mark carries its tools, faintly and out of the tab order unless it is the one picked", async () => {
  const { view } = await open();
  const sets = [...document.body.querySelectorAll(".annotator-marktools")];
  assert.equal(sets.length, 2, "one set per mark");
  const picked = query(document.body, ".annotator-marktools.picked");
  assert.ok(picked.querySelector('[aria-label="Delete arrow"]'), "the newest mark is picked until another is");
  const faint = query<HTMLButtonElement>(document.body, '[aria-label="Edit note on mark 1"]');
  assert.equal(faint.closest(".annotator-marktools")?.classList.contains("picked"), false);
  assert.equal(faint.tabIndex, -1);
  assert.equal(query<HTMLButtonElement>(picked, '[aria-label="Delete arrow"]').tabIndex, 0);

  await act(async () => { faint.click(); });
  assert.ok(query(document.body, ".annotator-label"), "a faint pencil still opens the note");
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

test("Escape keeps a box just drawn without its note, and Enter keeps it with one", async () => {
  const drawn = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };
  const { view } = await open();
  await act(async () => pointer.onBox(drawn));
  await act(async () => press(query(document.body, ".annotator-label"), "Escape"));
  assert.equal(document.body.querySelector(".annotator-label"), null);
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^3 marks/);
  assert.equal(query<HTMLButtonElement>(document.body, ".annotator-undo").disabled, false, "the kept box can be taken back");
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-undo").click());
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^2 marks/);

  await act(async () => pointer.onBox(drawn));
  await act(async () => press(query(document.body, ".annotator-label"), "Enter"));
  assert.match(query(document.body, ".annotator-count").textContent ?? "", /^3 marks/);
  assert.ok(query(document.body, '[aria-label="Delete mark 2"]'), "the kept box is the newest, so its tools show");
  await view.unmount();
});

test("Escape on a note being edited keeps the note it had", async () => {
  const { view, calls } = await open();
  await act(async () => query<HTMLButtonElement>(document.body, '[aria-label="Edit note on mark 1"]').click());
  const field = query<HTMLInputElement>(document.body, ".annotator-label");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "Changed");
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => press(field, "Escape"));
  assert.equal(document.body.querySelector(".annotator-label"), null);
  assert.equal(query<HTMLButtonElement>(document.body, ".annotator-undo").disabled, true);
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action.primary").click());
  assert.deepEqual(calls.applied, [marks]);
  await view.unmount();
});

test("Done keeps a box whose note is still being typed, and Cancel asks before dropping it", async () => {
  const drawn = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };
  const typeNote = async (text: string) => {
    const field = query<HTMLInputElement>(document.body, ".annotator-label");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      field.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });
  };

  const done = await open();
  await act(async () => pointer.onBox(drawn));
  await typeNote("Misaligned");
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action.primary").click());
  assert.deepEqual(done.calls.applied, [[...marks, { kind: "box", ...drawn, text: "Misaligned" }]]);
  await done.view.unmount();

  const cancel = await open();
  await act(async () => pointer.onBox(drawn));
  await act(async () => query<HTMLButtonElement>(document.body, ".annotator-action:not(.primary)").click());
  assert.equal(cancel.calls.cancelled, 0, "a box just drawn is a change");
  assert.match(query(document.body, ".annotator-bar").textContent ?? "", /Discard/);
  await act(async () => press(document.body, "Escape"));
  assert.ok(query(document.body, ".annotator-label"), "Escape leaves the discard question first, keeping the note");
  await cancel.view.unmount();
});

test("an arrow drawn up and to the left is ringed from its tip to its tail", () => {
  assert.deepEqual(markBounds({ kind: "arrow", x: 0.5, y: 0.5, width: -0.25, height: -0.125, text: "" }), { x: 0.25, y: 0.375, width: 0.25, height: 0.125 });
});
