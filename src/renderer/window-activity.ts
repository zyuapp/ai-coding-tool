/**
 * Marks the root while the window is not the one in use. Working indicators rest then, since each
 * one that moves makes Chromium draw the window on every display refresh.
 */
export function installWindowActivity() {
  const root = document.documentElement;
  const update = () => { root.toggleAttribute("data-window-inactive", !document.hasFocus()); };
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    root.removeAttribute("data-window-inactive");
  };
}
