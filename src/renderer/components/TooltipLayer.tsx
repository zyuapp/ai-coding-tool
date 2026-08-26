import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * One tooltip for the whole window, moved to whatever the pointer is resting on. Controls opt in with
 * a `data-tip`, so a list of ten thousand rows costs one listener rather than one component a row.
 */

/** How long the pointer rests before the first tooltip appears. Long enough not to flash while moving. */
const DELAY_MS = 400;

/** How long it takes once one is already open, so reading along a toolbar does not wait each time. */
const NEXT_MS = 60;

/** How far a tooltip sits from what it explains, and how close it may come to the window's edge. */
const GAP = 8;

type Tip = { text: string; rect: DOMRect };

function tipped(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showing = useRef<HTMLElement | null>(null);
  const open = useRef(false);
  /** Whether the last thing the user did was type, which is what makes focus worth explaining. */
  const typing = useRef(false);

  useEffect(() => {
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      showing.current = null;
      open.current = false;
      setTip((current) => current === null ? current : null);
    };

    const show = (element: HTMLElement, delay: number) => {
      /** Moving within one control is still resting on it, so its own tooltip is not restarted. */
      if (showing.current === element) return;
      if (timer.current) clearTimeout(timer.current);
      showing.current = element;
      const text = element.dataset.tip;
      if (!text) return hide();
      timer.current = setTimeout(() => {
        open.current = true;
        setTip({ text, rect: element.getBoundingClientRect() });
      }, delay);
    };

    const over = (event: MouseEvent) => {
      const element = tipped(event.target);
      if (element) show(element, open.current ? NEXT_MS : DELAY_MS);
      else hide();
    };

    const focus = (event: FocusEvent) => {
      const element = tipped(event.target);
      /** Focus reached by keyboard explains itself; a click already said what the control does. */
      if (element && typing.current) show(element, 0);
      else hide();
    };

    const pressed = () => {
      typing.current = true;
      hide();
    };

    const clicked = () => {
      typing.current = false;
      hide();
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("mousedown", clicked);
    document.addEventListener("keydown", pressed);
    /** A tooltip names a place on screen, so anything that moves that place takes it away. */
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("mousedown", clicked);
      document.removeEventListener("keydown", pressed);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /** Under the control, or above it when there is no room below, and never off either side. */
  useLayoutEffect(() => {
    const element = box.current;
    if (!tip || !element) return;
    const { width, height } = element.getBoundingClientRect();
    const below = tip.rect.bottom + GAP;
    const top = below + height > window.innerHeight - GAP ? tip.rect.top - height - GAP : below;
    const centred = tip.rect.left + tip.rect.width / 2 - width / 2;
    const left = Math.max(GAP, Math.min(centred, window.innerWidth - width - GAP));
    element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    element.dataset.placed = "true";
  }, [tip]);

  if (!tip) return null;
  return createPortal(<div className="tooltip" role="tooltip" ref={box}>{tip.text}</div>, document.body);
}
