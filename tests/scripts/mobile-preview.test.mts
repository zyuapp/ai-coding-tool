import assert from "node:assert/strict";
import { test } from "vitest";
// @ts-expect-error Native Electron JavaScript, typechecked separately by tsconfig.preview.json.
import { emulatePhone, phoneLayout } from "../../scripts/mobile-preview-layout.mjs";

test("the preview preserves phone CSS dimensions when fitting a small laptop display", () => {
  const workArea = { width: 1280, height: 720 };
  const frame = { width: 0, height: 28 };
  const portrait = phoneLayout(false, workArea, frame);
  assert.deepEqual(portrait.viewSize, { width: 390, height: 844 });
  assert.ok(portrait.scale < 1);
  assert.ok(portrait.height + frame.height + 32 <= workArea.height);
  assert.ok(portrait.width + frame.width + 32 <= workArea.width);
  assert.ok(Math.abs(portrait.width / portrait.height - 390 / 844) < 0.002);

  const landscape = phoneLayout(true, workArea, frame);
  assert.deepEqual(landscape.viewSize, { width: 844, height: 390 });
  assert.equal(landscape.scale, 1);
  assert.deepEqual([landscape.width, landscape.height], [844, 390]);
});

test("a large monitor displays the phone at its natural size", () => {
  const layout = phoneLayout(false, { width: 1920, height: 1080 }, { width: 2, height: 30 });
  assert.equal(layout.scale, 1);
  assert.deepEqual([layout.width, layout.height], [390, 844]);
});

test("native device emulation waits for the page render view", () => {
  const applied: Electron.Parameters[] = [];
  const contents = { enableDeviceEmulation(parameters: Electron.Parameters) { applied.push(parameters); } };
  const layout = phoneLayout(false, { width: 1280, height: 720 }, { width: 0, height: 28 });
  emulatePhone(contents, layout, false);
  assert.equal(applied.length, 0, "startup and navigation must not call into an absent native render view");
  emulatePhone(contents, layout, true);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].viewSize, { width: 390, height: 844 });
  assert.equal(applied[0].scale, layout.scale);
});
