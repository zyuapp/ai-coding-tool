/** Fired on the window when it comes into use or goes out of it. */
export const WINDOW_ACTIVITY_EVENT = "window-activity";

/** Whether the window is the one in use, its browser panel included. */
export function windowInUse() {
  return !document.documentElement.hasAttribute("data-window-inactive");
}

/** Hands the stylesheet the system's glass tint, which every pane of glass in the window thins or thickens by. */
export function installGlassTint() {
  const root = document.documentElement;
  const stop = window.desktop.onGlassTint((amount) => root.style.setProperty("--glass-tint", String(amount)));
  return () => {
    stop();
    root.style.removeProperty("--glass-tint");
  };
}

/**
 * Marks the root while the window is not the one in use. Working indicators rest then, since each
 * one that moves makes Chromium draw the window on every display refresh. Main reports it, because
 * the page loses focus to its own browser panel while the window is still in front.
 */
export function installWindowActivity() {
  const root = document.documentElement;
  const set = (active: boolean) => {
    if (active === windowInUse()) return;
    root.toggleAttribute("data-window-inactive", !active);
    window.dispatchEvent(new Event(WINDOW_ACTIVITY_EVENT));
  };
  set(document.hasFocus());
  const stop = window.desktop.onWindowActive(set);
  return () => {
    stop();
    root.removeAttribute("data-window-inactive");
  };
}
