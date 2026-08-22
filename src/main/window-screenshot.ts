import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemPreferences } from "electron";

export type WindowShot =
  | { status: "captured"; app: string; title: string; png: string }
  | { status: "denied" }
  | { status: "no-window"; app: string }
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
  ? { app: app, pid: pid, windowId: found.kCGWindowNumber, title: found.kCGWindowName || "" }
  : { app: app, pid: pid, windowId: null });
`;

type Pick = { app: string; pid: number; windowId: number | null; title?: string };

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

async function frontmostWindow(): Promise<Pick> {
  return JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PICK_WINDOW]));
}

/** Grabs the window the user is in without taking the keyboard from it. macOS only. */
export async function captureFrontmostWindow(): Promise<WindowShot> {
  if (process.platform !== "darwin") return { status: "failed", message: "Window capture is currently available only on macOS." };
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") return { status: "denied" };
  let directory: string | null = null;
  try {
    const window = await frontmostWindow();
    if (window.pid === process.pid) return { status: "no-window", app: "Claudex" };
    if (window.windowId === null) return { status: "no-window", app: window.app };
    directory = await mkdtemp(path.join(tmpdir(), "claudex-shot-"));
    const file = path.join(directory, "window.png");
    await run("/usr/sbin/screencapture", [`-l${window.windowId}`, "-x", "-o", file]);
    const png = await readFile(file);
    if (png.byteLength === 0) return { status: "denied" };
    return { status: "captured", app: window.app, title: window.title ?? "", png: png.toString("base64") };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
