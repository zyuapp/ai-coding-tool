import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { captureFrontmostHyprlandWindow } from "../../src/main/hyprland-window-capture.ts";
import { captureFrontmostWindow } from "../../src/main/window-screenshot.ts";

const { run } = vi.hoisted(() => ({ run: vi.fn<(command: string, args: string[], options: object, callback: (error: Error | null, stdout: string) => void) => void>() }));
vi.mock("node:child_process", () => ({ execFile: run, spawn: vi.fn() }));

const active = { stableId: "1800000a", pid: 424242, class: "org.example.Editor", title: "A window", at: [-900, 32], size: [875, 600], mapped: true, hidden: false };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6F9sAAAAASUVORK5CYII=", "base64");
let metadata: unknown;
let captureError: Error | null;
let bytes: Buffer;

beforeEach(() => {
  metadata = active;
  captureError = null;
  bytes = png;
  run.mockReset();
  run.mockImplementation((command, args, _options, callback) => {
    if (command === "hyprctl") callback(null, JSON.stringify(metadata));
    else if (command === "grim") {
      if (captureError) callback(captureError, "");
      else void writeFile(args.at(-1)!, bytes).then(() => callback(null, ""), (error: Error) => callback(error, ""));
    } else throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => vi.unstubAllEnvs());

test("captures a specific Hyprland toplevel and removes its temporary image", async () => {
  const shot = await captureFrontmostHyprlandWindow();
  assert.deepEqual(shot, { status: "captured", app: active.class, title: active.title, png: png.toString("base64"), frame: { x: -900, y: 32, width: 875, height: 600 } });
  assert.deepEqual(run.mock.calls[0]?.slice(0, 2), ["hyprctl", ["-j", "activewindow"]]);
  const capture = run.mock.calls[1]!;
  assert.deepEqual(capture[1].slice(0, 4), ["-T", active.stableId, "-t", "png"]);
  await assert.rejects(stat(path.dirname(capture[1].at(-1)!)), { code: "ENOENT" });
});

test("Wayland with DISPLAY still routes capture through Hyprland", { skip: process.platform !== "linux" }, async () => {
  vi.stubEnv("DISPLAY", ":0");
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "hyprland-test");
  assert.equal((await captureFrontmostWindow(false)).status, "captured");
  assert.deepEqual(run.mock.calls.map(([command]) => command), ["hyprctl", "grim"]);
});

test("desktop, hidden windows, and the app itself never start a capture", async () => {
  for (const candidate of [{}, { ...active, mapped: false }, { ...active, hidden: true }, { ...active, pid: process.pid }]) {
    metadata = candidate;
    assert.equal((await captureFrontmostHyprlandWindow()).status, "no-window");
  }
  assert.ok(run.mock.calls.every(([command]) => command === "hyprctl"));
});

test("missing toplevel IDs and invalid geometry fail without falling back to a screen crop", async () => {
  for (const candidate of [{ ...active, stableId: undefined }, { ...active, stableId: "" }, { ...active, size: [0, 600] }, null]) {
    metadata = candidate;
    assert.equal((await captureFrontmostHyprlandWindow()).status, "failed");
  }
  assert.ok(run.mock.calls.every(([command]) => command === "hyprctl"));
});

test("a window closing during capture reports failure and cleans up", async () => {
  captureError = new Error("toplevel not found");
  const shot = await captureFrontmostHyprlandWindow();
  assert.equal(shot.status, "failed");
  if (shot.status === "failed") assert.match(shot.message, /toplevel not found/);
  await assert.rejects(stat(path.dirname(run.mock.calls[1]![1].at(-1)!)), { code: "ENOENT" });
});

test("missing grim gives an actionable failure and invalid images are never attached", async () => {
  captureError = Object.assign(new Error("spawn grim ENOENT"), { code: "ENOENT" });
  const missing = await captureFrontmostHyprlandWindow();
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") assert.match(missing.message, /hyprctl and grim.*[Ii]nstall or update/);
  captureError = null;
  for (const invalid of [Buffer.alloc(0), Buffer.from("not a PNG")]) {
    bytes = invalid;
    assert.equal((await captureFrontmostHyprlandWindow()).status, "failed");
  }
});
