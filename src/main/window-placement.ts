import { app, screen, type BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the window sat, and whether the platform was holding it open at its largest. */
export type WindowPlacement = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  fullScreen?: boolean;
};

export type ScreenArea = { x: number; y: number; width: number; height: number };

export const DEFAULT_PLACEMENT: WindowPlacement = { width: 1240, height: 820 };

const MIN_WIDTH = 820;
const MIN_HEIGHT = 620;

/** How much of the window's top edge has to stay on a screen for the user to drag it back. */
const VISIBLE_EDGE = 80;

function isFinitePixel(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isWindowPlacement(value: unknown): value is WindowPlacement {
  if (!value || typeof value !== "object") return false;
  const placement = value as Record<string, unknown>;
  if (!isFinitePixel(placement.width) || !isFinitePixel(placement.height)) return false;
  if (placement.width < MIN_WIDTH || placement.height < MIN_HEIGHT) return false;
  for (const key of ["x", "y"]) {
    if (placement[key] !== undefined && !isFinitePixel(placement[key])) return false;
  }
  for (const key of ["maximized", "fullScreen"]) {
    if (placement[key] !== undefined && typeof placement[key] !== "boolean") return false;
  }
  return true;
}

/** An unreadable file simply means the default, which is what a first launch reads anyway. */
export function loadWindowPlacement(file: string): WindowPlacement {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isWindowPlacement(value) ? value : DEFAULT_PLACEMENT;
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

/**
 * Fits the remembered placement to the screens the user has now. A window wider than every screen
 * is cut down to the one it sits on, and a window on a screen that is gone loses its position, so
 * the platform places it again rather than opening it out of reach.
 */
export function fitPlacement(placement: WindowPlacement, screens: ScreenArea[]): WindowPlacement {
  if (!screens.length) return placement;
  const screen = screenUnder(placement, screens) ?? screens[0];
  const width = Math.max(MIN_WIDTH, Math.min(placement.width, screen.width));
  const height = Math.max(MIN_HEIGHT, Math.min(placement.height, screen.height));
  const fitted: WindowPlacement = { ...placement, width, height };
  if (!isFinitePixel(placement.x) || !isFinitePixel(placement.y) || !screenUnder(placement, screens)) {
    delete fitted.x;
    delete fitted.y;
    return fitted;
  }
  fitted.x = Math.min(Math.max(placement.x, screen.x - width + VISIBLE_EDGE), screen.x + screen.width - VISIBLE_EDGE);
  fitted.y = Math.min(Math.max(placement.y, screen.y), screen.y + screen.height - VISIBLE_EDGE);
  return fitted;
}

/** The screen that holds the window's title bar, which is the one the user reads it on. */
function screenUnder(placement: WindowPlacement, screens: ScreenArea[]) {
  if (!isFinitePixel(placement.x) || !isFinitePixel(placement.y)) return undefined;
  const x = placement.x;
  const y = placement.y;
  return screens.find(
    (screen) =>
      x + placement.width > screen.x &&
      x < screen.x + screen.width &&
      y + VISIBLE_EDGE > screen.y &&
      y < screen.y + screen.height,
  );
}

/** Writes queue behind one another, since two overlapping ones leave the tail of the longer. */
let placementWritten: Promise<void> = Promise.resolve();

export function rememberWindowPlacement(file: string, placement: WindowPlacement) {
  placementWritten = placementWritten.then(() => writeFile(file, JSON.stringify(placement))).catch(() => undefined);
  return placementWritten;
}

/**
 * Where the window sat when the user last left it, so a window closed at full size opens at full
 * size. Remembered on disk because the frame exists before the renderer can say anything about it.
 */
function placementPath() {
  return path.join(app.getPath("userData"), "window-placement.v1.json");
}

/** The remembered placement, fitted to the screens the user has now. */
export function rememberedPlacement() {
  const screens = screen.getAllDisplays().map((display) => display.workArea);
  return fitPlacement(loadWindowPlacement(placementPath()), screens);
}

function placementOf(target: BrowserWindow): WindowPlacement {
  /** The normal bounds, since the maximized ones are the screen and say nothing about the window. */
  return { ...target.getNormalBounds(), maximized: target.isMaximized(), fullScreen: target.isFullScreen() };
}

/** The user drags in many small steps, so the placement is written once the dragging stops. */
export function watchWindowPlacement(target: BrowserWindow) {
  let timer: NodeJS.Timeout | undefined;
  const record = () => {
    if (target.isDestroyed()) return;
    const placement = placementOf(target);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => rememberWindowPlacement(placementPath(), placement), 400);
  };
  target.on("resize", record);
  target.on("move", record);
  target.on("maximize", record);
  target.on("unmaximize", record);
  target.on("enter-full-screen", record);
  target.on("leave-full-screen", record);
  target.on("close", () => {
    if (timer) clearTimeout(timer);
    void rememberWindowPlacement(placementPath(), placementOf(target));
  });
}
