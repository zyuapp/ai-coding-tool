import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { RuntimeDesktopHost } from "../../src/main/runtime-desktop.ts";

vi.mock("electron", () => ({ app: {}, dialog: {}, shell: {}, BrowserWindow: class {}, nativeImage: {}, Notification: class {} }));

vi.mock("../../src/main/browser-host.ts", () => ({}));
vi.mock("../../src/main/browser-import.ts", () => ({}));

const { createRuntimeDesktop } = await import("../../src/main/runtime-desktop.ts");

test("handing the keys back from a page never raises a window the user has left", () => {
  let focused = false;
  const focusedContents: string[] = [];
  const window = { isFocused: () => focused, webContents: { focus: () => { focusedContents.push("window"); } } };
  const desktop = createRuntimeDesktop({ window: () => window } as unknown as RuntimeDesktopHost);

  desktop.focusWindow();
  assert.deepEqual(focusedContents, [], "another app keeps the keys");
  focused = true;
  desktop.focusWindow();
  assert.deepEqual(focusedContents, ["window"], "a window in front takes them back from its page");
});
