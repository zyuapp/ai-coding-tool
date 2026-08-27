import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../../support/renderer-dom.mts";

const { DiagramViewer, naturalDiagram } = await import("../../../src/renderer/components/MermaidBlock.tsx");

test("a diagram keeps the size it was drawn at instead of the container's cap", () => {
  const svg = '<svg aria-roledescription="flowchart-v2" viewBox="0 0 512.5 300" style="max-width: 512.5px; background-color: transparent;" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><g></g></svg>';

  const diagram = naturalDiagram(svg);

  assert.deepEqual([diagram.width, diagram.height], [512.5, 300]);
  assert.doesNotMatch(diagram.markup, /max-width/);
  assert.doesNotMatch(diagram.markup, /width="100%"/);
  assert.match(diagram.markup, /background-color/);
});

test("a diagram Mermaid could not size is framed by what it drew", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 148"><g></g></svg>';
  const drawing = dom.window.SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
  drawing.getBBox = () => ({ x: 10, y: 4, width: 300, height: 100 }) as DOMRect;

  try {
    const diagram = naturalDiagram(svg);

    assert.deepEqual([diagram.width, diagram.height], [316, 116]);
    assert.match(diagram.markup, /viewBox="2 -4 316 116"/);
  } finally {
    delete drawing.getBBox;
  }
});

test("markup without a usable viewBox is left exactly as it came", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>';

  const diagram = naturalDiagram(svg);

  assert.deepEqual([diagram.markup, diagram.width, diagram.height], [svg, 0, 0]);
});

test("the diagram viewer scales between the fitted size and 400%, and reports where it is", async () => {
  const diagram = { markup: '<svg viewBox="0 0 400 200"></svg>', width: 400, height: 200 };
  const view = await mount(React.createElement(DiagramViewer, { diagram, onClose: () => {} }));
  const zoom = (label: string) => query<HTMLButtonElement>(document, `.viewer-zoom button[aria-label="${label}"]`);
  const readout = () => query(document, ".viewer-zoom span").textContent;
  const drawn = () => query<HTMLElement>(document, ".viewer-stage .mermaid-svg").style.getPropertyValue("--diagram-width");

  assert.equal(readout(), "100%");
  assert.equal(drawn(), "400px");
  assert.equal(zoom("Zoom out").disabled, true);

  await act(async () => { zoom("Zoom in").click(); });
  assert.equal(readout(), "140%");
  assert.equal(drawn(), "560px");

  for (let step = 0; step < 8; step += 1) await act(async () => { zoom("Zoom in").click(); });
  assert.equal(readout(), "400%");
  assert.equal(zoom("Zoom in").disabled, true);

  for (let step = 0; step < 8; step += 1) await act(async () => { zoom("Zoom out").click(); });
  assert.equal(readout(), "100%");
  assert.equal(zoom("Zoom out").disabled, true);
  await view.unmount();
});

test("the diagram viewer closes on Escape and on the backdrop, but not on a drag off the diagram", async () => {
  const closed: string[] = [];
  const diagram = { markup: '<svg viewBox="0 0 400 200"></svg>', width: 400, height: 200 };
  const view = await mount(React.createElement(DiagramViewer, { diagram, onClose: () => closed.push("closed") }));
  const backdrop = query(document, ".viewer.diagram");
  const drawing = query(document, ".viewer-stage .mermaid-svg");
  const press = (target: Element) => target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
  const release = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  await act(async () => { press(drawing); release(backdrop); });
  assert.deepEqual(closed, []);

  await act(async () => { press(drawing); release(drawing); });
  assert.deepEqual(closed, []);

  await act(async () => { press(backdrop); release(backdrop); });
  assert.deepEqual(closed, ["closed"]);

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.deepEqual(closed, ["closed", "closed"]);
  await view.unmount();
});
