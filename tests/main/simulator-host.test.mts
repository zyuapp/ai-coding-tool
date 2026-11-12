import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
const { parseDeviceList, pastedText } = await import("../../src/main/simulator-host.ts");

test("devices list iOS only, newest runtime first and iPhones before iPads, skipping unavailable ones", () => {
  const listed = parseDeviceList(JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ udid: "old", name: "iPhone 16", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "watch", name: "Apple Watch", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
        { udid: "pad", name: "iPad (A16)", state: "Booted" },
        { udid: "phone", name: "iPhone 17", state: "Booting" },
        { udid: "gone", name: "iPhone 15", state: "Shutdown", isAvailable: false },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-10": [{ udid: "newest", name: "iPhone Air", state: "Creating" }],
    },
  }));
  assert.deepEqual(listed, [
    { udid: "newest", name: "iPhone Air", runtime: "iOS 26.10", state: "other" },
    { udid: "phone", name: "iPhone 17", runtime: "iOS 26.4", state: "booting" },
    { udid: "pad", name: "iPad (A16)", runtime: "iOS 26.4", state: "booted" },
    { udid: "old", name: "iPhone 16", runtime: "iOS 18.5", state: "shutdown" },
  ]);
  assert.deepEqual(parseDeviceList("{}"), []);
});

test("text a US keyboard cannot type is pasted whole, with the Returns at its end still pressed", () => {
  assert.equal(pastedText("plain text\n"), null);
  assert.deepEqual(pastedText("Grüße 👋\n"), { paste: "Grüße 👋", returns: "\n" });
  assert.deepEqual(pastedText("a\nñ"), { paste: "a\nñ", returns: "" });
});
