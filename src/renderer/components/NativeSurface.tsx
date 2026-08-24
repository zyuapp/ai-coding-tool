import { useEffect, useRef, type ReactNode } from "react";

/** The rectangle a native view is drawn over, in the window's own coordinates. */
export type SurfaceBox = { x: number; y: number; width: number; height: number };

/** How far a sample sits from the edge it belongs to, clear of anything that straddles that edge. */
const SAMPLE_INSET = 10;

/** Three points along one axis: one inside each edge, and the middle. */
function samples(start: number, size: number) {
  const inset = Math.min(SAMPLE_INSET, size / 2);
  return [start + inset, start + size / 2, start + size - inset];
}

/** Whether the document draws anything of its own over the box, which a native view would hide. */
function covered(element: HTMLElement, box: DOMRect) {
  return samples(box.y, box.height).some((down) => samples(box.x, box.width).some((across) => {
    const top = document.elementFromPoint(across, down);
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
    let following = 0;
    /** How many transitions are running that carry this box, so a slide is followed until it settles. */
    let sliding = 0;
    let reported = "";
    /** The last coverage answer, kept so a resize can report a rectangle without hit testing again. */
    let obscured = false;

    const send = (bounds: SurfaceBox | null) => {
      const signature = JSON.stringify(bounds);
      if (signature === reported) return;
      reported = signature;
      latest.current(bounds);
    };
    /** The box while it is big enough to draw in, else null. */
    const rect = () => {
      const box = element.getBoundingClientRect();
      return box.width >= 1 && box.height >= 1 ? box : null;
    };
    const measure = () => {
      frame = 0;
      const box = rect();
      obscured = box ? covered(element, box) : false;
      send(box && !obscured ? { x: box.x, y: box.y, width: box.width, height: box.height } : null);
    };
    /** Every trigger below can fire in bursts, and one answer a frame is as often as it can change. */
    const schedule = () => { frame ||= requestAnimationFrame(measure); };
    /** Where the box is now, on the coverage answer already in hand rather than a fresh hit test. */
    const place = () => {
      const box = rect();
      if (!box) send(null);
      else if (!obscured) send({ x: box.x, y: box.y, width: box.width, height: box.height });
    };
    /**
     * A resize is already laid out by the time it is delivered, so the new rectangle goes out in
     * this frame instead of the next. The view follows the panel's edge rather than trailing it by
     * a frame, which is what leaves a stale page over the rest of the window.
     */
    const resized = () => {
      place();
      schedule();
    };
    /**
     * A native view is drawn over this box rather than in it, so a panel that slides cannot carry it.
     * While a slide is running the box says where it is every frame; left to the end of the slide,
     * the view would stay behind on the workspace until the panel had gone.
     */
    const follow = () => {
      if (!sliding) return void (following = 0);
      place();
      following = requestAnimationFrame(follow);
    };
    /** Only a transition on something holding this box can move it; the rest of the window cannot. */
    const carries = (event: TransitionEvent) => event.target instanceof Node && event.target.contains(element);
    const slideStarted = (event: TransitionEvent) => {
      if (carries(event) && sliding++ === 0) following = requestAnimationFrame(follow);
    };
    /** A slide that is cut short still ends, so the count cannot be left holding a frame loop open. */
    const slideEnded = (event: TransitionEvent) => {
      if (carries(event) && sliding > 0) sliding -= 1;
      schedule();
    };

    measure();
    const resize = new ResizeObserver(resized);
    resize.observe(element);
    /** Anything mounting, hiding or restyling anywhere in the document can end up over this box. */
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style", "inert"] });
    window.addEventListener("resize", resized);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("transitionrun", slideStarted, true);
    window.addEventListener("transitionend", slideEnded, true);
    window.addEventListener("transitioncancel", slideEnded, true);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(following);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", resized);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("transitionrun", slideStarted, true);
      window.removeEventListener("transitionend", slideEnded, true);
      window.removeEventListener("transitioncancel", slideEnded, true);
      latest.current(null);
    };
  }, []);

  return <div className={className} ref={surface}>{children}</div>;
}
