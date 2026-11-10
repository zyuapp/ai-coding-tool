import assert from "node:assert/strict";
import { test } from "vitest";
import { loadWindowGlass, systemGlassTint, windowMaterial, windowMaterialOptions } from "../../src/main/window-backdrop.ts";

const glass = { attach: () => true, regions: () => true };

test("only macOS draws a material under the window, and glass only where the addon offers it", () => {
  assert.equal(windowMaterial(glass, "darwin"), "glass");
  assert.equal(windowMaterial(null, "darwin"), "vibrancy");
  assert.equal(windowMaterial(glass, "linux"), "none");
});

test("a window over a material is clear and vibrant, and an opaque one takes the theme's canvas", () => {
  assert.deepEqual(windowMaterialOptions("none", "#0e1117"), { backgroundColor: "#0e1117" });
  for (const material of ["glass", "vibrancy"] as const) {
    assert.partialDeepStrictEqual(windowMaterialOptions(material, "#0e1117"), { backgroundColor: "#00000000", vibrancy: "sidebar" });
  }
});

test("glass falls back to none when the addon is missing, refuses, or the platform has no use for it", () => {
  const loaded: string[] = [];
  const addon = (available: boolean) => (file: string) => {
    loaded.push(file);
    return { available: () => available, attach: () => true, regions: () => true };
  };
  assert.equal(loadWindowGlass("/native", "linux", addon(true)), null);
  assert.deepEqual(loaded, [], "another desktop never opens the addon");
  assert.equal(loadWindowGlass("/native", "darwin", () => { throw new Error("no such file"); }), null);
  assert.equal(loadWindowGlass("/native", "darwin", addon(false)), null);
  assert.equal(loadWindowGlass("/native", "darwin", addon(true))?.attach(Buffer.alloc(8)), true);
});

test("the system's glass tint is read as an amount between clear and full, and as clear when it is not kept", () => {
  assert.equal(systemGlassTint(() => 0.5), 0.5);
  assert.equal(systemGlassTint(() => 7), 1);
  assert.equal(systemGlassTint(() => -1), 0);
  assert.equal(systemGlassTint(() => undefined), 0);
});
