import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { GlassRegion } from "../contracts/glass.js";
import type { WindowGlass } from "./window-backdrop.js";

/** The name the page opens its glass layer under, which is the only window it may open. */
export const GLASS_LAYER_FRAME = "glass-layer";

/** The argument that tells the page's process it may open one. */
export const GLASS_LAYER_ARGUMENT = "--glass-layer";

/** The see-through window that floats over the app and holds what sits on real glass. */
export type GlassLayer = {
  setRegions(regions: readonly GlassRegion[]): void;
  /** Whether the layer takes the pointer; it lets everything through to the window under it otherwise. */
  setInteractive(interactive: boolean): void;
  focus(): void;
  focused(): boolean;
  /** Whether the layer's glass is drawn as in use, which follows the window under it rather than the layer's own turn at the keyboard. */
  setInUse(inUse: boolean): void;
};

/**
 * A panel over the window's page and exactly its size: see-through, without a frame or a shadow of
 * its own, and never the app's main window, so the window under it keeps looking like the one in use.
 */
export function glassLayerWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    type: "panel",
    ...parent.getContentBounds(),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
  };
}

/** A page names its panes in its own pixels, which a zoomed page draws larger than the window's points. */
export function glassRegionsInPoints(regions: readonly GlassRegion[], zoom: number): GlassRegion[] {
  if (zoom === 1) return [...regions];
  return regions.map(({ x, y, width, height, radius, clear }) => ({ x: x * zoom, y: y * zoom, width: width * zoom, height: height * zoom, radius: radius * zoom, clear }));
}

/** Keeps the layer over its window's page and at its zoom, lets the pointer through it, and puts glass under what it draws. */
export function startGlassLayer(parent: BrowserWindow, layer: BrowserWindow, glass: WindowGlass): GlassLayer {
  const fit = () => {
    if (!parent.isDestroyed() && !layer.isDestroyed()) layer.setBounds(parent.getContentBounds());
  };
  for (const moved of ["resize", "move", "enter-full-screen", "leave-full-screen", "restore", "show"] as const) parent.on(moved as "resize", fit);
  layer.setIgnoreMouseEvents(true, { forward: true });
  fit();
  layer.showInactive();
  return {
    setRegions: (regions) => {
      if (layer.isDestroyed() || parent.isDestroyed()) return;
      /** The layer is a page of its own, so it is kept at the zoom of the page it floats over. */
      const zoom = parent.webContents.getZoomFactor();
      if (layer.webContents.getZoomFactor() !== zoom) layer.webContents.setZoomFactor(zoom);
      glass.regions(layer.getNativeWindowHandle(), glassRegionsInPoints(regions, zoom));
    },
    setInteractive: (interactive) => {
      if (layer.isDestroyed()) return;
      if (interactive) layer.setIgnoreMouseEvents(false);
      else layer.setIgnoreMouseEvents(true, { forward: true });
    },
    focus: () => {
      if (!layer.isDestroyed()) layer.focus();
    },
    focused: () => !layer.isDestroyed() && layer.isFocused(),
    setInUse: (inUse) => {
      if (!layer.isDestroyed()) glass.active(layer.getNativeWindowHandle(), inUse);
    },
  };
}
