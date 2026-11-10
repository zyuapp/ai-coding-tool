/**
 * What sits on the frame with nothing of the page behind it: the chosen row of a sidebar and the
 * sidebar's own buttons. Each gets a pane of the platform's glass under the page, where it is.
 */
const FRAME_PANES = ".task-row.active, .settings-sidebar button.active, .new-task-button, .sidebar-search";
/** Where the frame's panes can change: the two sidebars. */
const FRAME_SIDES = ".sidebar, .settings-sidebar";

/** Keeps a pane of glass under each of the frame's panes as they are chosen, scrolled and resized. */
export function followFramePanes() {
  let frame = 0;
  let told = "";
  const report = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const regions = [...document.querySelectorAll<HTMLElement>(FRAME_PANES)].flatMap((pane) => {
        if (!pane.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return [];
        const box = pane.getBoundingClientRect();
        /** A row scrolled part of the way out of its list keeps only the part still in it. */
        const within = pane.closest(".sidebar-scroll, .settings-sidebar nav")?.getBoundingClientRect();
        const top = Math.max(box.top, within?.top ?? box.top);
        const bottom = Math.min(box.bottom, within?.bottom ?? box.bottom);
        if (box.width === 0 || bottom - top < 8) return [];
        return [{ x: box.left, y: top, width: box.width, height: bottom - top, radius: Number.parseFloat(getComputedStyle(pane).borderTopLeftRadius) || 0 }];
      });
      /** A zoom moves every pane on the screen without moving any on the page, so the page's scale is part of what is told. */
      const telling = JSON.stringify([devicePixelRatio, regions]);
      if (telling === told) return;
      told = telling;
      void window.desktop.setWindowGlassRegions(regions);
    });
  };
  const watched = new WeakSet<Element>();
  const sides = new MutationObserver(report);
  const watch = () => {
    for (const side of document.querySelectorAll(FRAME_SIDES)) {
      if (watched.has(side)) continue;
      watched.add(side);
      sides.observe(side, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      new ResizeObserver(report).observe(side);
    }
    report();
  };
  /** The sidebars come and go with the views that own them, so the page is watched only for that. */
  const shell = () => document.querySelector(".app-shell");
  const mounted = new MutationObserver(() => {
    const within = shell();
    if (within && !watched.has(within)) {
      watched.add(within);
      new MutationObserver(watch).observe(within, { childList: true });
    }
    watch();
  });
  mounted.observe(document.body, { childList: true, subtree: false });
  const root = document.getElementById("root");
  if (root) mounted.observe(root, { childList: true });
  document.addEventListener("scroll", report, true);
  window.addEventListener("resize", report);
  document.addEventListener("transitionrun", report);
  document.addEventListener("transitionend", report);
}
