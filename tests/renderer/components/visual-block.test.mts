import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../../support/renderer-dom.mts";

/** The theme is read from computed styles, which the shared test document does not expose globally. */
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
const { VisualBlock, restyleVisuals, visualTitle } = await import("../../../src/renderer/components/VisualBlock.tsx");

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

test("a visual that failed can be drawn again in a fresh frame, and one that drew offers no retry", async () => {
  const view = await mount(React.createElement(VisualBlock, { source: '<div id="viz-retry"></div>' }));
  const first = frameOf(view.container);
  assert.equal(view.container.querySelector(".visual-error button"), null);

  await say(first.contentWindow, { type: "aicodingtool-visual:error", message: "broke" });
  const retry = view.container.querySelector<HTMLButtonElement>(".visual-error button");
  assert.equal(retry?.textContent, "Try again");
  await act(async () => { retry!.click(); });
  assert.equal(view.container.querySelector(".visual-error"), null, "the error clears while it draws again");
  assert.notEqual(frameOf(view.container), first, "the visual is drawn into a new frame");
  await view.unmount();
});

test("a visual's frame is named by its title or first heading", async () => {
  assert.equal(visualTitle("<title>Load  by region</title><h1>Other</h1>"), "Load by region");
  assert.equal(visualTitle('<div><h2 class="t">Retry <em>budget</em></h2></div>'), "Retry budget");
  assert.equal(visualTitle("<div>No heading</div>"), "Visual");

  const view = await mount(React.createElement(VisualBlock, { source: "<h1>Queue depth</h1>" }));
  assert.equal(frameOf(view.container).title, "Queue depth");
  await view.unmount();
});

test("a visual's error keeps its first line in view beside the retry", async () => {
  const view = await mount(React.createElement(VisualBlock, { source: '<div id="viz-reason"></div>' }));
  await say(frameOf(view.container).contentWindow, { type: "aicodingtool-visual:error", message: "chart is not defined\n  at line 3" });
  assert.equal(query(view.container, ".visual-error .block-error-reason").textContent, "chart is not defined");
  await view.unmount();
});

test("a visual opens at full size in a viewer of its own, which keeps the inline height and closes on Escape", async () => {
  const { DiagramViewerHost } = await import("../../../src/renderer/components/MermaidBlock.tsx");
  const source = '<div id="viz-full"></div>';
  const view = await mount(React.createElement(DiagramViewerHost, null, React.createElement(VisualBlock, { source })));
  const inline = frameOf(view.container);
  await say(inline.contentWindow, { type: "aicodingtool-visual:size", height: 200 });

  const expand = query<HTMLButtonElement>(view.container, 'button[aria-label="Open the visual at full size"]');
  assert.equal(expand.tabIndex, 0, "the keyboard reaches it, since the visual itself is no button");
  await act(async () => { expand.click(); });
  const dialog = query<HTMLElement>(document.body, '[role="dialog"][aria-label="Visual"]');
  const full = dialog.querySelector("iframe") as HTMLIFrameElement & { contentWindow: Window };
  assert.ok(full && full !== inline, "the viewer draws the visual in its own frame");
  assert.equal(dialog.querySelector('button[aria-label="Open the visual at full size"]'), null);

  await say(full.contentWindow, { type: "aicodingtool-visual:size", height: 640 });
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await view.unmount();

  const again = await mount(React.createElement(VisualBlock, { source }));
  assert.equal(again.container.querySelector<HTMLElement>(".visual-block")!.style.getPropertyValue("--visual-height"), "200px", "the viewer's height is not kept for the inline visual");
  await again.unmount();
});
