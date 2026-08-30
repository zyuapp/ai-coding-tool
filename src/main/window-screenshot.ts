import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopCapturer, systemPreferences } from "electron";
import type { WindowFrame } from "./capture-flash.js";
import { windowCaptureCapability } from "./platform-capabilities.js";

/** macOS's own screenshot shutter, which is the sound the gesture already means to everyone. */
const SHUTTER = "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Grab.aif";

/**
 * The shutter, played beside the capture rather than after it. `screencapture` is told not to make
 * a sound of its own, so this stays one choice rather than two that can disagree.
 */
export function playShutter() {
  if (process.platform !== "darwin" || !existsSync(SHUTTER)) return;
  try {
    const player = spawn("/usr/bin/afplay", [SHUTTER], { detached: true, stdio: "ignore" });
    player.once("error", () => undefined);
    player.unref();
  } catch {
    /** A shutter that will not play is not worth failing the capture over. */
  }
}

export type WindowShot =
  | { status: "captured"; app: string; title: string; png: string; frame: WindowFrame }
  | { status: "denied" }
  | { status: "no-window"; app: string }
  | { status: "unsupported"; message: string }
  | { status: "failed"; message: string };

/**
 * The frontmost app's frontmost ordinary window, as CoreGraphics reports it. Reading the window
 * list needs no permission of its own, and asking for it never activates this app, so the answer
 * still describes whatever the user was looking at when the hotkey landed.
 */
const PICK_WINDOW = `
ObjC.import("AppKit");
ObjC.bindFunction("CGWindowListCopyWindowInfo", ["id", ["unsigned int", "unsigned int"]]);
var ON_SCREEN = 1, NO_DESKTOP = 16;
var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
var pid = front.processIdentifier;
var app = ObjC.unwrap(front.localizedName);
var windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(ON_SCREEN | NO_DESKTOP, 0));
var found = windows.find(function (window) {
  return window.kCGWindowOwnerPID === pid
    && window.kCGWindowLayer === 0
    && window.kCGWindowBounds.Width > 60
    && window.kCGWindowBounds.Height > 60;
});
JSON.stringify(found
  ? { app: app, pid: pid, windowId: found.kCGWindowNumber, title: found.kCGWindowName || "", bounds: found.kCGWindowBounds }
  : { app: app, pid: pid, windowId: null });
`;

type CoreGraphicsBounds = { X: number; Y: number; Width: number; Height: number };

type Pick = { app: string; pid: number; windowId: number | null; title?: string; bounds?: CoreGraphicsBounds };

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

async function frontmostMacWindow(): Promise<Pick> {
  return JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PICK_WINDOW]));
}

async function captureFrontmostMacWindow(sound: boolean): Promise<WindowShot> {
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") return { status: "denied" };
  let directory: string | null = null;
  try {
    const window = await frontmostMacWindow();
    if (window.pid === process.pid) return { status: "no-window", app: "AI Coding Tool" };
    if (window.windowId === null) return { status: "no-window", app: window.app };
    directory = await mkdtemp(path.join(tmpdir(), "aic-shot-"));
    const file = path.join(directory, "window.png");
    await run("/usr/sbin/screencapture", [`-l${window.windowId}`, "-x", "-o", file]);
    if (sound) playShutter();
    const png = await readFile(file);
    if (png.byteLength === 0) return { status: "denied" };
    const bounds = window.bounds ?? { X: 0, Y: 0, Width: 0, Height: 0 };
    const frame = { x: bounds.X, y: bounds.Y, width: bounds.Width, height: bounds.Height };
    return { status: "captured", app: window.app, title: window.title ?? "", png: png.toString("base64"), frame };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

type X11Window = { id: number; pid: number | null; app: string; title: string; width: number; height: number };

export function x11ActiveWindowId(output: string): number | null {
  const value = /(?:^|\s)(0x[\da-f]+)(?:\s|$)/i.exec(output)?.[1];
  if (!value) return null;
  const id = Number.parseInt(value, 16);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function quotedValues(value: string): string[] {
  return [...value.matchAll(/"(?:\\.|[^"\\])*"/g)].flatMap((match) => {
    try { return [JSON.parse(match[0]) as string]; } catch { return []; }
  });
}

export function x11WindowProperties(id: number, output: string): Omit<X11Window, "width" | "height"> {
  const lines = output.split("\n");
  const nameLine = lines.find((line) => line.startsWith("_NET_WM_NAME"))
    ?? lines.find((line) => line.startsWith("WM_NAME"));
  const classLine = lines.find((line) => line.startsWith("WM_CLASS"));
  const pidLine = lines.find((line) => line.startsWith("_NET_WM_PID"));
  const rawPid = pidLine ? /=\s*(\d+)/.exec(pidLine)?.[1] : undefined;
  const pid = rawPid ? Number.parseInt(rawPid, 10) : null;
  const title = nameLine ? quotedValues(nameLine).at(0) ?? "" : "";
  const classes = classLine ? quotedValues(classLine) : [];
  const app = classes.at(-1) || classes.at(0) || title || "Unknown app";
  return { id, pid: Number.isSafeInteger(pid) && pid! > 0 ? pid : null, app, title };
}

/** xwininfo reports device pixels, which is exactly the size Electron's X11 thumbnail needs. */
export function x11WindowSize(output: string): { width: number; height: number } | null {
  const width = /^\s*Width:\s*(\d+)\s*$/m.exec(output)?.[1];
  const height = /^\s*Height:\s*(\d+)\s*$/m.exec(output)?.[1];
  if (!width || !height) return null;
  const size = { width: Number.parseInt(width, 10), height: Number.parseInt(height, 10) };
  return Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0 ? size : null;
}

export function desktopSourceWindowId(sourceId: string): number | null {
  const value = /^window:(0x[\da-f]+|\d+):/i.exec(sourceId)?.[1];
  if (!value) return null;
  const id = Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function frontmostX11Window(): Promise<X11Window | null> {
  const id = x11ActiveWindowId(await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]));
  if (id === null) return null;
  const target = `0x${id.toString(16)}`;
  const [properties, geometry] = await Promise.all([
    run("xprop", ["-id", target, "_NET_WM_PID", "_NET_WM_NAME", "WM_NAME", "WM_CLASS"]),
    run("xwininfo", ["-id", target]),
  ]);
  const size = x11WindowSize(geometry);
  if (!size) throw new Error("xwininfo did not report a usable active-window size.");
  return { ...x11WindowProperties(id, properties), ...size };
}

export function x11CaptureFailureMessage(cause: unknown) {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT") {
    return "X11 window capture needs xprop and xwininfo. Install those tools (the x11-utils package on Debian or Ubuntu), then try again.";
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Could not capture the active X11 window: ${message}`;
}

async function captureFrontmostX11Window(): Promise<WindowShot> {
  try {
    const window = await frontmostX11Window();
    if (!window) return { status: "no-window", app: "the desktop" };
    if (window.pid === process.pid) return { status: "no-window", app: "AI Coding Tool" };
    /** Keep every enumerated thumbnail no larger than the one window whose pixels we need. */
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: window.width, height: window.height } });
    const source = sources.find((candidate) => desktopSourceWindowId(candidate.id) === window.id);
    if (!source) return { status: "failed", message: "The active X11 window is not available to Electron's desktop capture service." };
    if (source.thumbnail.isEmpty()) return { status: "failed", message: "The desktop capture service returned an empty image for the active window." };
    const png = source.thumbnail.toPNG();
    if (png.byteLength === 0) return { status: "failed", message: "The desktop capture service returned an empty image for the active window." };
    return {
      status: "captured",
      app: window.app,
      title: window.title || source.name,
      png: png.toString("base64"),
      /** Capture flash remains macOS-only, so Linux does not need unsafe compositor geometry. */
      frame: { x: 0, y: 0, width: 0, height: 0 },
    };
  } catch (cause) {
    return { status: "failed", message: x11CaptureFailureMessage(cause) };
  }
}

/** Grabs the window the user is in without taking the keyboard from it. */
export async function captureFrontmostWindow(sound: boolean): Promise<WindowShot> {
  const capability = windowCaptureCapability();
  if (capability.status === "unsupported") return capability;
  if (process.platform === "darwin") return captureFrontmostMacWindow(sound);
  if (capability.display !== "x11") {
    return { status: "unsupported", message: "The active Linux display does not expose a safe global window-capture path." };
  }
  return captureFrontmostX11Window();
}
