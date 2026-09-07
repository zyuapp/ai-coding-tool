import assert from "node:assert/strict";
import { test } from "vitest";
import { applyWindowChrome, windowChrome } from "../../src/renderer/platform.ts";

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
