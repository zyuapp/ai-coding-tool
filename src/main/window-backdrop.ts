import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import type { GlassRegion } from "../contracts/glass.js";
import type { WindowMaterial } from "../contracts/ipc.js";

/** The native layer that puts Liquid Glass under a window's page. */
export type WindowGlass = {
  /** Whether glass went under the window that owns this handle. */
  attach(handle: Buffer): boolean;
  /** Lays one pane of glass per region under a see-through window's page, in that window's own coordinates. */
  regions(handle: Buffer, regions: readonly GlassRegion[]): boolean;
  /** Has a window draw its glass as the window in use does, or as one out of use. */
  active(handle: Buffer, active: boolean): boolean;
};

type GlassAddon = { available(): boolean; attach(handle: Buffer): boolean; regions(handle: Buffer, flat: number[]): boolean; active(handle: Buffer, active: boolean): boolean };

/**
 * Glass needs the addon and a macOS that has it. A build without the addon, or one that will not
 * load, leaves the window on vibrancy alone.
 */
export function loadWindowGlass(nativeDirectory: string, platform: NodeJS.Platform = process.platform, load?: (file: string) => unknown): WindowGlass | null {
  if (platform !== "darwin") return null;
  try {
    const addon = (load ?? createRequire(__filename))(path.join(nativeDirectory, "aic-glass.node")) as GlassAddon;
    if (!addon.available()) return null;
    return {
      attach: (handle) => addon.attach(handle),
      regions: (handle, regions) => addon.regions(handle, regions.flatMap(({ x, y, width, height, radius }) => [x, y, width, height, radius])),
      active: (handle, active) => addon.active(handle, active),
    };
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
