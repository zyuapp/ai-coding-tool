import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount } from "../../support/renderer-dom.mts";

/** The theme is read from computed styles, which the shared test document does not expose globally. */
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
const { VisualBlock, restyleVisuals } = await import("../../../src/renderer/components/VisualBlock.tsx");

function frameOf(container: HTMLElement) {
  const frame = container.querySelector("iframe");
  assert.ok(frame?.contentWindow, "the visual is drawn in a frame");
  return frame as HTMLIFrameElement & { contentWindow: Window };
}

async function say(source: unknown, data: unknown) {
  await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: source as MessageEventSource })); });
}

test("the window takes size and error reports only from its own frame, and keeps the first error", async () => {
  const view = await mount(React.createElement(VisualBlock, { source: '<div id="viz-sized"></div>' }));
  const frame = frameOf(view.container);
  const block = view.container.querySelector<HTMLElement>(".visual-block")!;
  assert.equal(frame.hasAttribute("data-ready"), false, "a frame stays hidden until it has measured");

  await say(dom.window, { type: "aicodingtool-visual:size", height: 300 });
  assert.equal(block.style.getPropertyValue("--visual-height"), "", "another window's report is ignored");

  await say(frame.contentWindow, { type: "aicodingtool-visual:size", height: 412.4 });
  assert.equal(block.style.getPropertyValue("--visual-height"), "413px");
  assert.equal(frame.hasAttribute("data-ready"), true);

  await say(frame.contentWindow, { type: "aicodingtool-visual:error", message: "first is not defined" });
  await say(frame.contentWindow, { type: "aicodingtool-visual:error", message: "second" });
  assert.equal(view.container.querySelector(".visual-error pre")?.textContent, "first is not defined");
  await view.unmount();

  const again = await mount(React.createElement(VisualBlock, { source: '<div id="viz-sized"></div>' }));
  assert.equal(again.container.querySelector<HTMLElement>(".visual-block")!.style.getPropertyValue("--visual-height"), "413px", "a remounted visual starts at the height it measured");
  await again.unmount();
});

test("a theme change is posted to every mounted frame without reloading it, and stops once it unmounts", async () => {
  const view = await mount(React.createElement(VisualBlock, { source: '<div id="viz-themed"></div>' }));
  const frame = frameOf(view.container);
  const posted: unknown[] = [];
  frame.contentWindow.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];

  await act(async () => { frame.dispatchEvent(new dom.window.Event("load")); });
  assert.equal((posted[0] as { type: string; html: string }).type, "aicodingtool-visual:render");
  assert.equal((posted[0] as { html: string }).html, '<div id="viz-themed"></div>');

  restyleVisuals();
  const theme = posted[1] as { type: string; scheme: string; vars: Record<string, string> };
  assert.equal(theme.type, "aicodingtool-visual:theme");
  assert.ok("--series-1" in theme.vars && "--font-sans" in theme.vars);
  assert.equal(view.container.querySelector("iframe"), frame, "the frame is kept, so the visual keeps its state");

  await view.unmount();
  restyleVisuals();
  assert.equal(posted.length, 2);
});
