import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import type { WindowMaterial } from "../contracts/ipc.js";

/** The native layer that lays Liquid Glass over a window's vibrancy. */
export type WindowGlass = {
  /** Whether glass went under the window that owns this handle. */
  attach(handle: Buffer): boolean;
};

type GlassAddon = { available(): boolean; attach(handle: Buffer): boolean };

/**
 * Glass needs the addon and a macOS that has it. A build without the addon, or one that will not
 * load, leaves the window on vibrancy alone.
 */
export function loadWindowGlass(nativeDirectory: string, platform: NodeJS.Platform = process.platform, load?: (file: string) => unknown): WindowGlass | null {
  if (platform !== "darwin") return null;
  try {
    const addon = (load ?? createRequire(__filename))(path.join(nativeDirectory, "aic-glass.node")) as GlassAddon;
    return addon.available() ? { attach: (handle) => addon.attach(handle) } : null;
  } catch {
    return null;
  }
}

/** macOS draws a material under the window; other desktops keep an opaque one. */
export function windowMaterial(glass: WindowGlass | null, platform: NodeJS.Platform = process.platform): WindowMaterial {
  if (platform !== "darwin") return "none";
  return glass ? "glass" : "vibrancy";
}

/**
 * A window over a material is created clear, with the vibrancy that makes Chromium composite it as
 * a translucent one. An opaque window takes the theme's canvas, so it never flashes another colour.
 */
export function windowMaterialOptions(material: WindowMaterial, canvas: string): Pick<BrowserWindowConstructorOptions, "backgroundColor" | "vibrancy" | "visualEffectState"> {
  if (material === "none") return { backgroundColor: canvas };
  return { backgroundColor: "#00000000", vibrancy: "sidebar", visualEffectState: "followWindow" };
}

/**
 * How tinted the person has set the system's glass, from 0 for the clearest to 1. The system keeps
 * it under this name; a macOS that does not answers 0, which is also how its glass is drawn.
 */
export function systemGlassTint(read: (key: string, type: "float") => unknown): number {
  const amount = Number(read("NSGlassTintAmount", "float"));
  return Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
}

/** How the renderer's process is told which material is under it, before its first paint. */
export const WINDOW_MATERIAL_ARGUMENT = "--window-material=";
