import { BrowserWindow } from "electron";

/** A window's place on screen, in the screen points both CoreGraphics and Electron count in. */
export type WindowFrame = { x: number; y: number; width: number; height: number };

const FLASH_MS = 200;
/** Long enough for the fade to finish before the overlay goes, short enough to never be in the way. */
const TEARDOWN_MS = FLASH_MS + 120;

const FLASH_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><style>
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
div { height: 100%; background: #fff; animation: flash ${FLASH_MS}ms ease-out forwards; }
@keyframes flash { from { opacity: 0.9 } to { opacity: 0 } }
</style><div></div>`)}`;

/**
 * Whitens the window that was just captured, the way a camera says it took the picture. Drawn after
 * the capture, so the flash is never in the shot, and only where the app is coming forward anyway:
 * showing a window of our own activates this app whatever the window is told about focus.
 */
export function flashWindow(frame: WindowFrame) {
  if (process.platform !== "darwin") return;
  if (frame.width < 1 || frame.height < 1) return;
  const overlay = new BrowserWindow({
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: "panel",
    show: false,
  });
  overlay.setIgnoreMouseEvents(true);
  /** Above the window coming forward, so the flash is not drawn under what it is announcing. */
  overlay.setAlwaysOnTop(true, "screen-saver");
  void overlay.loadURL(FLASH_PAGE);
  overlay.showInactive();
  setTimeout(() => {
    if (!overlay.isDestroyed()) overlay.destroy();
  }, TEARDOWN_MS).unref?.();
}
