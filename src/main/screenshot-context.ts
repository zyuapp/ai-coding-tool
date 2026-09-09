import { app, systemPreferences, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAccessibilitySnapshot, MAX_SCREENSHOT_CONTEXT_NAME, type AccessibilitySnapshot, type ScreenshotContext } from "../domain/screenshot-context.js";
import type { ScreenshotTarget } from "./screenshot-context-snapshot.js";

export const SCREENSHOT_CONTEXT_TIMEOUT_MS = 1_500;
let active: UtilityProcess | null = null;

/**
 * Native traversal runs in a disposable process: a hung app or native failure cannot freeze
 * Electron, and the deadline stops the work itself. At most one metadata walk runs at a time.
 */
export async function captureScreenshotContext(target: ScreenshotTarget): Promise<ScreenshotContext> {
  const base = {
    version: 1 as const,
    platform: target.platform,
    app: target.app.slice(0, MAX_SCREENSHOT_CONTEXT_NAME),
    title: target.title.slice(0, MAX_SCREENSHOT_CONTEXT_NAME),
    capturedAt: Date.now(),
  };
  let accessibility: AccessibilitySnapshot;
  try {
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !Number.isSafeInteger(target.windowId) || target.windowId <= 0) accessibility = { status: "unavailable", reason: "window" };
    else if (target.platform === "macos" && !systemPreferences.isTrustedAccessibilityClient(false)) accessibility = { status: "unavailable", reason: "permission" };
    else if (active) accessibility = { status: "unavailable", reason: "busy" };
    else accessibility = await read(target);
  } catch {
    accessibility = { status: "unavailable", reason: "failed" };
  }
  return { ...base, accessibility };
}

function read(target: ScreenshotTarget): Promise<AccessibilitySnapshot> {
  return new Promise((resolve) => {
    let worker: UtilityProcess;
    try {
      const sdk = pathToFileURL(app.isPackaged
        ? path.join(process.resourcesPath, "cua-sdk", "node_modules", "@trycua", "cua-driver", "dist", "index.js")
        : path.join(app.getAppPath(), "node_modules", "@trycua", "cua-driver", "dist", "index.js")).href;
      const environment = { ...process.env };
      // Read the user's compositor, even if computer-control tools are disabled or XWayland exists.
      delete environment.CUA_WAYLAND_NEST;
      if (target.platform === "linux-hyprland") environment.CUA_DRIVER_RS_ENABLE_WAYLAND = "1";
      worker = utilityProcess.fork(path.join(__dirname, "screenshot-context-worker.mjs"), [sdk], {
        serviceName: "Screenshot context", stdio: "ignore", env: environment,
      });
      active = worker;
    } catch {
      resolve({ status: "unavailable", reason: "failed" });
      return;
    }
    let settled = false;
    const stop = () => finish({ status: "unavailable", reason: "failed" });
    const finish = (snapshot: AccessibilitySnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      app.removeListener("will-quit", stop);
      try { worker.kill(); } catch { /* The process may already have exited. */ }
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish({ status: "unavailable", reason: "timeout" }), SCREENSHOT_CONTEXT_TIMEOUT_MS);
    worker.once("exit", () => {
      if (active === worker) active = null;
      finish({ status: "unavailable", reason: "failed" });
    });
    worker.once("message", (value: unknown) => finish(isAccessibilitySnapshot(value) ? value : { status: "unavailable", reason: "failed" }));
    app.once("will-quit", stop);
    try { worker.postMessage(target); } catch { finish({ status: "unavailable", reason: "failed" }); }
  });
}
