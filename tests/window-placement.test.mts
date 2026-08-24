import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DEFAULT_PLACEMENT, fitPlacement, loadWindowPlacement, rememberWindowPlacement } from "../src/main/window-placement.ts";

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

async function placementFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), "placement-")), "window-placement.v1.json");
}

test("the window opens where it was left", async () => {
  const file = await placementFile();
  await rememberWindowPlacement(file, { x: 40, y: 60, width: 1400, height: 900, maximized: false, fullScreen: true });

  assert.deepEqual(loadWindowPlacement(file), { x: 40, y: 60, width: 1400, height: 900, maximized: false, fullScreen: true });
});

test("a file that was never written reads as the default", async () => {
  assert.deepEqual(loadWindowPlacement(path.join(tmpdir(), "no-such-placement.json")), DEFAULT_PLACEMENT);
});

test("a file holding something else reads as the default", async () => {
  const file = await placementFile();
  await writeFile(file, JSON.stringify({ width: 10, height: 10 }));

  assert.deepEqual(loadWindowPlacement(file), DEFAULT_PLACEMENT);
});

test("a window wider than the screen is cut down to it", () => {
  const fitted = fitPlacement({ x: 0, y: 0, width: 3000, height: 2000 }, [SCREEN]);

  assert.deepEqual(fitted, { x: 0, y: 0, width: 1920, height: 1080 });
});

test("a window on a screen that is gone loses its position", () => {
  const fitted = fitPlacement({ x: 2400, y: 200, width: 1240, height: 820, fullScreen: true }, [SCREEN]);

  assert.deepEqual(fitted, { width: 1240, height: 820, fullScreen: true });
});

test("a window dragged off the bottom keeps its title bar on screen", () => {
  const fitted = fitPlacement({ x: 100, y: 1040, width: 1240, height: 820 }, [SCREEN]);

  assert.equal(fitted.y, 1000);
  assert.equal(fitted.x, 100);
});

test("a second screen keeps the window that sits on it", () => {
  const second = { x: 1920, y: 0, width: 1440, height: 900 };
  const fitted = fitPlacement({ x: 2000, y: 100, width: 1240, height: 820 }, [SCREEN, second]);

  assert.deepEqual(fitted, { x: 2000, y: 100, width: 1240, height: 820 });
});
