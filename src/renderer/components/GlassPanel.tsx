import { useEffect, useLayoutEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openGlassLayer, type GlassLayerView } from "../glass-layer";

/** The layer once it is open, and null until then or where the window has none. */
function useGlassLayer(wanted: boolean) {
  const [layer, setLayer] = useState<GlassLayerView | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void openGlassLayer().then((opened) => {
      if (current) setLayer(opened);
    });
    return () => { current = false; };
  }, [wanted]);
  return wanted ? layer : null;
}

/**
 * Keeps a pane in the glass layer over the slot the page left for it. The slot gives the pane its
 * place and its width, the pane gives the slot its height, and a slot that is covered or scrolled
 * away takes its pane out of sight with it.
 */
function useSlotGeometry(layer: GlassLayerView | null, slot: HTMLElement | null, host: HTMLElement | null, fit: "frame" | "slot") {
  useLayoutEffect(() => {
    const frame = slot?.parentElement;
    const pane = host?.firstElementChild;
    if (!layer || !slot || !host || !frame || !(pane instanceof layer.window.HTMLElement)) return;
    const place = () => {
      const at = slot.getBoundingClientRect();
      /** A pane laid out by its surroundings takes their width; one that is its own size sits exactly on its slot. */
      const across = fit === "frame" ? frame.getBoundingClientRect() : at;
      host.style.left = `${across.left}px`;
      host.style.width = `${across.width}px`;
      host.style.top = `${at.top}px`;
      layer.reportRegions();
    };
    const follow = () => {
      slot.style.height = `${pane.offsetHeight}px`;
      place();
    };
    /** Out of sight rather than gone, so the pane keeps the height its slot is holding open for it. */
    const cover = (covered: boolean) => {
      host.toggleAttribute("data-covered", covered);
      layer.reportRegions();
    };
    /** A move with no change of size, like the composer gliding between a new thread and an open one, is followed frame by frame. */
    let gliding = 0;
    const glide = () => {
      place();
      gliding = requestAnimationFrame(glide);
    };
    const rest = () => {
      cancelAnimationFrame(gliding);
      gliding = 0;
      place();
    };
    const start = () => {
      if (!gliding) glide();
    };
    const page = new ResizeObserver(place);
    page.observe(frame);
    page.observe(document.documentElement);
    const grown = new layer.window.ResizeObserver(follow);
    grown.observe(pane);
    const seen = new IntersectionObserver(([entry]) => {
      cover(!(entry?.isIntersecting && (entry as IntersectionObserverEntry & { isVisible?: boolean }).isVisible !== false));
    }, { trackVisibility: true, delay: 100 } as IntersectionObserverInit);
    seen.observe(slot);
    document.addEventListener("transitionrun", start);
    document.addEventListener("transitionend", rest);
    document.addEventListener("transitioncancel", rest);
    follow();
    return () => {
      page.disconnect();
      grown.disconnect();
      seen.disconnect();
      cancelAnimationFrame(gliding);
      document.removeEventListener("transitionrun", start);
      document.removeEventListener("transitionend", rest);
      document.removeEventListener("transitioncancel", rest);
      layer.reportRegions();
    };
  }, [layer, slot, host, fit]);
}

type PaneProps = Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

/**
 * A pane that sits on real glass where the window has a glass layer, and is drawn in place, on the
 * stylesheet's own glass, everywhere else. `frame` names the classes the pane's surroundings carry,
 * which its styles are written against; a pane that is its own size, like a round button, fits its
 * slot instead. A clear pane shows what is behind it; the others frost it.
 */
export function GlassPanel({ layered, className, frame, fit = "frame", clear = false, as: Pane = "div", children, ...pane }: PaneProps & {
  layered: boolean;
  className: string;
  frame: string;
  fit?: "frame" | "slot";
  clear?: boolean;
  as?: "div" | "button";
  children: ReactNode;
}) {
  const layer = useGlassLayer(layered);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useSlotGeometry(layer, slot, host, fit);
  const kind = Pane === "button" ? { type: "button" as const } : {};
  if (!layer) return <Pane className={className} {...kind} {...pane}>{children}</Pane>;
  return (
    <>
      <div ref={setSlot} className={`${className} glass-slot`} aria-hidden="true" />
      {createPortal(
        <div ref={setHost} className={`glass-host ${frame}`} data-fit={fit}>
          <Pane className={className} data-glass-region={clear ? "clear" : ""} {...kind} {...pane}>{children}</Pane>
        </div>,
        layer.root,
      )}
    </>
  );
}
