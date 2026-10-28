import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../../support/renderer-dom.mts";

const render = vi.fn<(id: string, source: string) => Promise<{ svg: string }>>();
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, source: string) => render(id, source) } }));
Object.defineProperty(dom.window.document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });

const { MermaidBlock } = await import("../../../src/renderer/components/MermaidBlock.tsx");

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
  const retry = query<HTMLButtonElement>(error, "button");
  assert.equal(retry.textContent, "Try again");

  await act(async () => { retry.click(); });
  await settle();
  assert.equal(view.container.querySelector(".mermaid-error"), null);
  assert.ok(view.container.querySelector(".mermaid-svg svg"), "the second try draws the diagram");
  assert.notEqual(render.mock.calls[0]![0], render.mock.calls[1]![0], "each try renders under its own id");
  await view.unmount();
});
