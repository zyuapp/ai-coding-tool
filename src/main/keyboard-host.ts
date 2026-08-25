import { globalShortcut, shell, type BrowserWindow } from "electron";
import { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from "../domain/capture.js";
import { desktopAccelerator, formatShortcut, keystrokeOf, resolveShortcuts, shortcutFor, type ShortcutBinding, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import { writeAttachment } from "./attachment-store.js";
import { flashWindow } from "./capture-flash.js";
import { notify } from "./desktop-notice.js";
import { captureFrontmostWindow } from "./window-screenshot.js";

/** What the keyboard needs from main: the window an action lands in, and bringing it back to the user. */
export type KeyboardHost = {
  window: () => BrowserWindow | null;
  reveal: () => void;
};

export type KeyboardBridge = {
  /** Whether the app took the keystroke, which is also whether the page or the menu must not see it. */
  handleKey: (input: Electron.Input, surface: ShortcutSurface) => boolean;
  claimDesktopShortcut: () => void;
  releaseDesktopShortcut: () => void;
  setShortcuts: (overrides: ShortcutOverrides) => void;
  setCapturing: (capturing: boolean) => void;
  setCaptureOptions: (options: CaptureOptions) => void;
};

/**
 * The keyboard. Matching happens here rather than in the window, because a page in the browser panel
 * swallows every keystroke it is given, and the window decides what each action means once it lands.
 */
let shortcuts: ShortcutBinding[] = resolveShortcuts({});
/** While settings wait for a keystroke, every keystroke goes to them instead of to an action. */
let capturingShortcut = false;
/** How a grab announces itself. The window owns the choice and hands it over as the user changes it. */
let captureOptions = DEFAULT_CAPTURE_OPTIONS;
/** What the desktop is currently holding for us, so an unchanged binding is never re-registered. */
let desktopBinding: string | null = null;

function sendToWindow(host: KeyboardHost, channel: string, payload?: unknown) {
  const window = host.window();
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function handleKey(host: KeyboardHost, input: Electron.Input, surface: ShortcutSurface): boolean {
  if (input.type !== "keyDown") return false;
  const stroke = keystrokeOf(input, process.platform === "darwin");
  if (!stroke) return false;
  if (capturingShortcut) {
    if (stroke.key === "Escape") sendToWindow(host, "window:shortcut-captured", null);
    else if (stroke.mod || stroke.ctrl || stroke.alt) sendToWindow(host, "window:shortcut-captured", formatShortcut(stroke));
    else return false;
    return true;
  }
  const binding = shortcutFor(shortcuts, stroke, surface);
  if (!binding) return false;
  sendToWindow(host, "window:shortcut", { action: binding.action, surface });
  return true;
}

async function captureWindowToComposer(host: KeyboardHost) {
  const shot = await captureFrontmostWindow(captureOptions.sound);
  if (shot.status === "captured") {
    try {
      const file = await writeAttachment(shot.png);
      sendToWindow(host, "window:screenshot", { app: shot.app, title: shot.title, path: file });
      /** Only ever after the capture: neither the flash nor coming forward belongs in the shot. */
      if (captureOptions.focus) {
        flashWindow(shot.frame);
        host.reveal();
      } else notify("Screenshot attached", `${shot.app} — waiting in AI Coding Tool`);
    } catch (error) {
      notify("Could not keep the screenshot", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (shot.status === "denied") {
    notify("AI Coding Tool needs Screen Recording", "Grant it in System Settings → Privacy & Security, then try again.");
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return;
  }
  if (shot.status === "no-window") notify("Nothing to capture", `${shot.app} has no window on screen.`);
  else notify("Could not capture the window", shot.message);
}

function releaseDesktopShortcut() {
  globalShortcut.unregisterAll();
  desktopBinding = null;
}

/**
 * Claims the capture keystroke from the whole desktop. Carbon registers it without activating us, so
 * the app the user is in keeps the keyboard and stays the app the capture describes.
 */
function claimDesktopShortcut(host: KeyboardHost) {
  if (process.platform !== "darwin") return;
  const wanted = shortcuts.find((binding) => binding.surface === "desktop" && binding.action === "window.capture");
  const accelerator = wanted ? desktopAccelerator(wanted.binding) : null;
  if (accelerator === desktopBinding) return;
  releaseDesktopShortcut();
  desktopBinding = accelerator;
  if (!accelerator) return;
  if (!globalShortcut.register(accelerator, () => void captureWindowToComposer(host))) {
    desktopBinding = null;
    sendToWindow(host, "window:shortcut-refused", wanted!.binding);
  }
}

export function startKeyboardHost(host: KeyboardHost): KeyboardBridge {
  return {
    handleKey: (input, surface) => handleKey(host, input, surface),
    claimDesktopShortcut: () => claimDesktopShortcut(host),
    releaseDesktopShortcut,
    setShortcuts: (overrides) => { shortcuts = resolveShortcuts(overrides); },
    setCapturing: (capturing) => { capturingShortcut = capturing; },
    setCaptureOptions: (options) => { captureOptions = options; },
  };
}
