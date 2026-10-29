import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../../support/renderer-dom.mts";

const render = vi.fn<(id: string, source: string) => Promise<{ svg: string }>>();
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, source: string) => render(id, source) } }));
Object.defineProperty(dom.window.document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });

const { DiagramViewerHost, MermaidBlock, redrawDiagrams } = await import("../../../src/renderer/components/MermaidBlock.tsx");

async function settle() {
  await act(async () => { await vi.waitFor(() => assert.equal(document.querySelector(".mermaid-loading"), null)); });
}

test("a diagram that failed names why in view, and draws on a second try", async () => {
  render.mockRejectedValueOnce(new Error("Parse error on line 2:\ngraph TD; A-->\n-------^"));
  render.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 100 50"><g></g></svg>' });
  const view = await mount(React.createElement(MermaidBlock, { source: "graph TD; A-->" }));
  await settle();

  const error = query(view.container, ".mermaid-error");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(query(error, ".block-error-reason").textContent, "Parse error on line 2:", "the first line shows without opening the details");
  const retry = query<HTMLButtonElement>(error, ".limit-action");
  assert.equal(retry.textContent, "Try again");

  await act(async () => { retry.click(); });
  await settle();
  assert.equal(view.container.querySelector(".mermaid-error"), null);
  assert.ok(view.container.querySelector(".mermaid-svg svg"), "the second try draws the diagram");
  assert.notEqual(render.mock.calls[0]![0], render.mock.calls[1]![0], "each try renders under its own id");
  await view.unmount();
});

test("an open diagram is redrawn in a new theme instead of closing, though its row has scrolled away", async () => {
  render.mockReset();
  render.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 100 50"><g id="before"></g></svg>' });
  const host = (child: React.ReactNode) => React.createElement(DiagramViewerHost, null, child);
  const view = await mount(host(React.createElement(MermaidBlock, { source: "graph TD; A-->B;" })));
  await settle();

  const expand = query<HTMLButtonElement>(view.container, ".diagram-expand");
  assert.equal(expand.tabIndex, 0, "Full size is the keyboard's way to open the diagram");
  assert.equal(expand.getAttribute("aria-label"), "Open the diagram at full size");
  assert.equal(view.container.querySelector(".mermaid-open")?.tagName, "SPAN", "the drawing is a pointer shortcut, not a second tab stop");
  await act(async () => { query<HTMLElement>(view.container, ".mermaid-open").click(); });
  assert.ok(document.querySelector(".viewer.diagram #before"));
  await view.render(host(null));

  render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 50"><g id="after"></g></svg>' });
  await act(async () => { redrawDiagrams(); });
  await vi.waitFor(async () => {
    await act(async () => {});
    assert.ok(document.querySelector(".viewer.diagram #after"));
  });
  await view.unmount();
});
