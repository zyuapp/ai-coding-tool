import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { applyWindowChrome, windowChrome } from "../../src/renderer/platform.ts";

const styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

test("only macOS uses inset renderer window chrome", () => {
  assert.equal(windowChrome("macos"), "inset");
  assert.equal(windowChrome("linux"), "native");
  assert.equal(windowChrome("other"), "native");

  const root = { dataset: {} } as Pick<HTMLElement, "dataset">;
  applyWindowChrome("linux", root);
  assert.equal(root.dataset.windowChrome, "native");
  applyWindowChrome("macos", root);
  assert.equal(root.dataset.windowChrome, "inset");
});

test("traffic-light spacing is supplied only by inset window chrome", () => {
  assert.match(styles, /--window-controls-inset:\s*0px;/);
  assert.match(styles, /--settings-titlebar-inset:\s*0px;/);
  assert.match(styles, /:root\[data-window-chrome="inset"\]\s*\{[^}]*--window-controls-inset:\s*84px;[^}]*--settings-titlebar-inset:\s*48px;/s);
  assert.match(styles, /\.settings-traffic-space\s*\{\s*height:\s*var\(--settings-titlebar-inset\);/);
  assert.doesNotMatch(styles, /(?:topbar|right-dock-tabs)[^\n{]*\{[^}\n]*(?:padding-left|padding-inline):\s*84px/);
});
