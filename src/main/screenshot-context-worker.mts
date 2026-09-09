import { snapshotWindowAccessibility, type ScreenshotTarget } from "./screenshot-context-snapshot.js";
import type { AccessibilitySnapshot } from "../domain/screenshot-context.js";

const parentPort = (process as typeof process & { parentPort: {
  once(event: "message", listener: (event: { data: ScreenshotTarget }) => void): void;
  postMessage(snapshot: AccessibilitySnapshot): void;
} }).parentPort;

parentPort.once("message", ({ data }) => void capture(data));

async function capture(target: ScreenshotTarget) {
  try {
    const { CuaDriver } = await import(process.argv[2]) as typeof import("@trycua/cua-driver");
    const driver = CuaDriver.create(undefined) as ReturnType<typeof CuaDriver.create> & { uniffiDestroy(): void };
    try {
      parentPort.postMessage(await snapshotWindowAccessibility(driver, target));
    } finally {
      await driver.shutdown();
      driver.uniffiDestroy();
    }
  } catch {
    parentPort.postMessage({ status: "unavailable", reason: "failed" });
  }
}
