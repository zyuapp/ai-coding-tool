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
    webContents: { zoom: 1, getZoomFactor() { return this.zoom; }, setZoomFactor(zoom: number) { this.zoom = zoom; } },
  });
  return { window: window as unknown as BrowserWindow & { content: typeof content; webContents: { zoom: number } }, calls };
}

test("the glass layer stays over its window's page, at its zoom, with glass under the panes it names", () => {
  const parent = fakeWindow();
  const layer = fakeWindow();
  const glassed: unknown[] = [];
  let tracked = 0;
  const started = startGlassLayer(parent.window, layer.window, { attach: () => true, active: () => true, track: () => { tracked += 1; return true; }, regions: (_handle, regions) => { glassed.push(regions); return true; } });
  assert.equal(tracked, 1, "the platform is told which window lets the pointer through");
  assert.deepEqual(layer.calls, [["setBounds", parent.window.content], ["showInactive"]]);

  parent.window.content = { x: 10, y: 20, width: 1200, height: 700 };
  parent.window.emit("resize");
  assert.deepEqual(layer.calls.at(-1), ["setBounds", { x: 10, y: 20, width: 1200, height: 700 }]);

  const regions = [{ x: 1, y: 2, width: 300, height: 100, radius: 17, clear: true }];
  started.setRegions(regions);
  assert.deepEqual(glassed, [regions]);

  parent.window.webContents.zoom = 1.2;
  started.setRegions([{ x: 10, y: 20, width: 300, height: 100, radius: 10, clear: false }]);
  assert.equal(layer.window.webContents.zoom, 1.2, "the layer takes the zoom of the page it floats over");
  assert.deepEqual(glassed.at(-1), [{ x: 12, y: 24, width: 360, height: 120, radius: 12, clear: false }], "and its panes are laid where the zoomed page drew them");
});
