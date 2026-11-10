import type { DesktopPlatform, WindowMaterial } from "../contracts/ipc";

/** Whether the window is drawn on macOS, which is the only thing shortcut text needs to know. */
export const MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

export type WindowChrome = "inset" | "native";

/** macOS draws inset controls over the renderer; framed desktops keep their controls outside it. */
export function windowChrome(platform: DesktopPlatform): WindowChrome {
  return platform === "macos" ? "inset" : "native";
}

/**
 * One renderer marker owns every spacing decision that follows the shape of the native frame, and
 * one more says whether the platform draws a material under the page for the chrome to show.
 */
export function applyWindowChrome(platform: DesktopPlatform, material: WindowMaterial = "none", root: Pick<HTMLElement, "dataset"> = document.documentElement) {
  root.dataset.windowChrome = windowChrome(platform);
  if (material === "none") delete root.dataset.windowMaterial;
  else root.dataset.windowMaterial = material;
  /** Over Liquid Glass the whole window is drawn as one sheet. */
  if (material === "glass") root.dataset.glassSheet = "";
  else delete root.dataset.glassSheet;
}
