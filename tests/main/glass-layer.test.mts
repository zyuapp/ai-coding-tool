import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import type { BrowserWindow } from "electron";
import { startGlassLayer } from "../../src/main/glass-layer.ts";

function fakeWindow(content = { x: 10, y: 20, width: 800, height: 600 }) {
  const calls: unknown[][] = [];
  const window = Object.assign(new EventEmitter(), {
    content,
    isDestroyed: () => false,
    getContentBounds: () => window.content,
    setBounds: (bounds: unknown) => { calls.push(["setBounds", bounds]); },
    setIgnoreMouseEvents: (...args: unknown[]) => { calls.push(["setIgnoreMouseEvents", ...args]); },
    showInactive: () => { calls.push(["showInactive"]); },
    getNativeWindowHandle: () => Buffer.alloc(8),
    focus: () => { calls.push(["focus"]); },
    isFocused: () => false,
  });
  return { window: window as unknown as BrowserWindow & { content: typeof content }, calls };
}

test("the glass layer stays over its window's page and lets the pointer through until it is told to take it", () => {
  const parent = fakeWindow();
  const layer = fakeWindow();
  const glassed: unknown[] = [];
  const started = startGlassLayer(parent.window, layer.window, { attach: () => true, regions: (_handle, regions) => { glassed.push(regions); return true; } });
  assert.deepEqual(layer.calls, [["setIgnoreMouseEvents", true, { forward: true }], ["setBounds", parent.window.content], ["showInactive"]]);

  parent.window.content = { x: 10, y: 20, width: 1200, height: 700 };
  parent.window.emit("resize");
  assert.deepEqual(layer.calls.at(-1), ["setBounds", { x: 10, y: 20, width: 1200, height: 700 }]);

  started.setInteractive(true);
  assert.deepEqual(layer.calls.at(-1), ["setIgnoreMouseEvents", false]);
  started.setInteractive(false);
  assert.deepEqual(layer.calls.at(-1), ["setIgnoreMouseEvents", true, { forward: true }]);

  const regions = [{ x: 1, y: 2, width: 300, height: 100, radius: 17 }];
  started.setRegions(regions);
  assert.deepEqual(glassed, [regions]);
});
