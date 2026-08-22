import { useEffect, useRef, type ReactNode } from "react";

/** The rectangle a native view is drawn over, in the window's own coordinates. */
export type SurfaceBox = { x: number; y: number; width: number; height: number };

/** Points across the box, inset from its edges so a sample never lands on the element beside it. */
const SAMPLES = [0.02, 0.5, 0.98];

/** Whether the document draws anything of its own over the box, which a native view would hide. */
function covered(element: HTMLElement, box: DOMRect) {
  return SAMPLES.some((down) => SAMPLES.some((across) => {
    const top = document.elementFromPoint(box.x + box.width * across, box.y + box.height * down);
    return !top || !element.contains(top);
  }));
}

type NativeSurfaceProps = {
  className?: string;
  /** Where to draw, or null while the box is gone, off screen, or under something. */
  report: (box: SurfaceBox | null) => void;
  children?: ReactNode;
};

/**
 * A box that main draws a native view over. Those views sit above every element whatever its
 * z-index, so the box reports itself only while the document leaves it uncovered — a modal, a menu
 * or a panel sliding away is found by hit testing these points rather than by naming it here.
 */
export function NativeSurface({ className, report, children }: NativeSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef(report);
  latest.current = report;

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let frame = 0;
    let reported = "";
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const drawable = box.width >= 1 && box.height >= 1 && !covered(element, box);
      const bounds = drawable ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      const signature = JSON.stringify(bounds);
      if (signature === reported) return;
      reported = signature;
      latest.current(bounds);
    };
    /** Every trigger below can fire in bursts, and one answer a frame is as often as it can change. */
    const schedule = () => { frame ||= requestAnimationFrame(measure); };

    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    /** Anything mounting, hiding or restyling anywhere in the document can end up over this box. */
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style", "inert"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    /** A panel that slides ends up somewhere the frame it started in cannot say. */
    window.addEventListener("transitionend", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("transitionend", schedule, true);
      latest.current(null);
    };
  }, []);

  return <div className={className} ref={surface}>{children}</div>;
}
