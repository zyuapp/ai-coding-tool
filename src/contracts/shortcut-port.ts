import type { CaptureOptions } from "../domain/capture.js";
import type { ShortcutOverrides } from "../domain/shortcuts.js";
import type { DesktopShortcutRefusal, ShortcutInvocation, WindowScreenshot } from "./ipc.js";

/** The keystrokes main matches, and the window grabs the desktop hotkey makes. */
export type ShortcutPort = {
  runtime: {
    /** How a grab announces itself. Main owns both, so it is told rather than asked. */
    setCaptureOptions(options: CaptureOptions): void;
    /** The keystrokes main matches, so a shortcut works inside a page the window never hears from. */
    setShortcuts(overrides: ShortcutOverrides): void;
    /** While settings wait for a keystroke, main hands every one of them over instead of acting on it. */
    setShortcutCapture(capturing: boolean): void;
  };
  windowOwn: {
    /** A window grabbed by the desktop hotkey, on its way to the composer the user was last in. */
    onWindowScreenshot(listener: (shot: WindowScreenshot) => void): () => void;
    /** A desktop-wide binding main could not claim, with a platform reason when the path is unavailable. */
    onDesktopShortcutRefused(listener: (refusal: DesktopShortcutRefusal) => void): () => void;
    onShortcut(listener: (invocation: ShortcutInvocation) => void): () => void;
    /** What was pressed while capturing, or null for the Escape that calls it off. */
    onShortcutCaptured(listener: (binding: string | null) => void): () => void;
  };
};
