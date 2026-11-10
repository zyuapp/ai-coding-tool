import assert from "node:assert/strict";
import { test } from "vitest";
import { applyWindowChrome } from "../../src/renderer/platform.ts";

test("the root says which material is under the window, and says nothing when there is none", () => {
  const root = { dataset: {} as DOMStringMap };
  applyWindowChrome("macos", "glass", root);
  assert.deepEqual({ ...root.dataset }, { windowChrome: "inset", windowMaterial: "glass" });
  applyWindowChrome("linux", "none", root);
  assert.deepEqual({ ...root.dataset }, { windowChrome: "native" });
});
