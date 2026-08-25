import assert from "node:assert/strict";
import { test } from "vitest";
import { item } from "../../support/renderer-dom.mts";

const { badgeRadius, drawAnnotations, placeBadges } = await import("../../../src/renderer/components/ImageAnnotator.tsx");

type RecordingContext = CanvasRenderingContext2D & {
  calls: { text: string[]; strokes: number; fills: number };
};

function recordingContext(): RecordingContext {
  const calls = { text: [] as string[], strokes: 0, fills: 0 };
  const context = {
    measureText: (value: string) => ({ width: value.length * 7 }),
    fillText: (value: string) => calls.text.push(value),
    strokeRect: () => { calls.strokes += 1; },
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => { calls.fills += 1; },
  };
  return Object.assign(context, { calls }) as unknown as RecordingContext;
}

test("arrows draw without a mark and never renumber the boxes around them", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "first" },
    { kind: "arrow", x: 0.8, y: 0.8, width: -0.3, height: -0.3, text: "" },
    { kind: "box", x: 0.5, y: 0.5, width: 0.2, height: 0.2, text: "second" },
  ], 1000, 800);

  assert.deepEqual(context.calls.text, ["1", "2"]);
  assert.equal(context.calls.strokes, 2);
});

test("marks take their screenshot's letter when a send carries more than one", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "text 1" },
    { kind: "box", x: 0.5, y: 0.5, width: 0.2, height: 0.2, text: "text 2" },
  ], 1000, 800, "B");

  assert.deepEqual(context.calls.text, ["B1", "B2"]);
});

test("a mark carries its number alone, however long the note behind it is", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.4, width: 0.2, height: 0.2, text: "this note is long enough to have needed more than one line of chip" },
  ], 1000, 800);

  assert.deepEqual(context.calls.text, ["1"]);
});

test("badges on boxes drawn over each other are moved apart rather than stacked", () => {
  const radius = badgeRadius(1000, 800);
  const spots = placeBadges([
    { x: 300, y: 300, width: 200, height: 160 },
    { x: 306, y: 304, width: 200, height: 160 },
    { x: 312, y: 308, width: 200, height: 160 },
  ], 1000, 800);

  assert.equal(spots.length, 3);
  for (let one = 0; one < spots.length; one += 1) {
    for (let other = one + 1; other < spots.length; other += 1) {
      const oneSpot = item(spots[one]);
      const otherSpot = item(spots[other]);
      assert.ok(
        Math.hypot(oneSpot.x - otherSpot.x, oneSpot.y - otherSpot.y) >= radius * 2,
        `badges ${one + 1} and ${other + 1} overlap`,
      );
    }
  }
});

test("a badge on a box at the edge stays inside the image", () => {
  const radius = badgeRadius(1000, 800);
  const [corner] = placeBadges([{ x: 0, y: 0, width: 120, height: 90 }], 1000, 800);
  assert.ok(corner);

  assert.ok(corner.x >= radius && corner.x <= 1000 - radius);
  assert.ok(corner.y >= radius && corner.y <= 800 - radius);
});
