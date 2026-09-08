/** Keys that deliberately navigate or operate a control, rather than just change a modifier. */
const NAVIGATION_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " ", "Escape"]);

/**
 * Window-local DOM presentation, like the caret: changing it never moves focus or workspace state.
 * Chromium can mark a mouse-focused button :focus-visible after Shift alone. Window activation
 * and restored menu focus must not make that old control look like a new keyboard destination.
 */
export function installFocusAppearance() {
  const root = document.documentElement;
  const previous = root.dataset.focusAppearance;
  let focused = document.hasFocus();
  const set = (keyboard: boolean) => {
    const appearance = keyboard ? "keyboard" : "quiet";
    if (root.dataset.focusAppearance !== appearance) root.dataset.focusAppearance = appearance;
  };
  const quiet = () => set(false);
  const keydown = (event: KeyboardEvent) => {
    if (focused && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && NAVIGATION_KEYS.has(event.key)) set(true);
  };
  const blur = () => { focused = false; quiet(); };
  const focus = () => { focused = true; quiet(); };
  const visibility = () => { if (document.visibilityState === "hidden") blur(); };

  quiet();
  // Capture runs before menus move focus, including portals and handlers that stop propagation.
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("pointerdown", quiet, true);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("pointerdown", quiet, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visibility);
    if (previous === undefined) delete root.dataset.focusAppearance;
    else root.dataset.focusAppearance = previous;
  };
}

export function keyboardFocusVisible() {
  return document.documentElement.dataset.focusAppearance === "keyboard";
}
