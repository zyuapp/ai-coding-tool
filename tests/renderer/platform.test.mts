import assert from "node:assert/strict";
import { test } from "vitest";
import { applyWindowChrome } from "../../src/renderer/platform.ts";

test("the root says which material is under the window, and says nothing when there is none", () => {
  const root = { dataset: {} as DOMStringMap };
  applyWindowChrome("macos", "glass", root);
  assert.deepEqual({ ...root.dataset }, { windowChrome: "inset", windowMaterial: "glass", glassSheet: "" });
  applyWindowChrome("macos", "vibrancy", root);
  assert.deepEqual({ ...root.dataset }, { windowChrome: "inset", windowMaterial: "vibrancy" }, "only Liquid Glass makes the window one sheet");
  applyWindowChrome("linux", "none", root);
  assert.deepEqual({ ...root.dataset }, { windowChrome: "native" });
});
