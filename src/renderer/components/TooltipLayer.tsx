import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { keyboardFocusVisible } from "../focus-appearance";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";

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

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

type Tip = { text: string; rect: DOMRect };

/** A control's tooltip: its name, with the keystroke that does the same. */
export function shortcutTip(label: string, binding: string) {
  return `${label} (${displayShortcut(binding, MAC)})`;
}

function tipped(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

/** Points a control's description at the open tip, unless the tip only repeats the control's name. */
function describe(element: HTMLElement, id: string, text: string) {
  const name = element.getAttribute("aria-label") ?? element.textContent?.trim();
  if (text === name) return false;
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  if (!ids.includes(id)) element.setAttribute("aria-describedby", [...ids, id].join(" "));
  return true;
}

function undescribe(element: HTMLElement, id: string) {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter((token) => token && token !== id) ?? [];
  if (ids.length) element.setAttribute("aria-describedby", ids.join(" "));
  else element.removeAttribute("aria-describedby");
}

/** Whether the element, or text inside it, is cut short by its box. */
function truncated(element: HTMLElement) {
  return [element, ...element.querySelectorAll<HTMLElement>("*")]
    .some((node) => node instanceof HTMLElement && node.scrollWidth > node.clientWidth);
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const described = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showing = useRef<HTMLElement | null>(null);
  const open = useRef(false);

  useEffect(() => {
    const release = () => {
      if (described.current) undescribe(described.current, id);
      described.current = null;
    };

    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      release();
      showing.current = null;
      open.current = false;
      setTip((current) => current === null ? current : null);
    };

    const show = (element: HTMLElement, delay: number) => {
      /** Moving within one control is still resting on it, so its own tooltip is not restarted. */
      if (showing.current === element) return;
      if (timer.current) clearTimeout(timer.current);
      release();
      showing.current = element;
      const text = element.dataset.tip;
      /** `data-tip-overflow` marks a tip that repeats visible text, so it shows only while that text is cut short. */
      if (!text || ("tipOverflow" in element.dataset && !truncated(element))) return hide();
      timer.current = setTimeout(() => {
        open.current = true;
        if (describe(element, id, text)) described.current = element;
        setTip({ text, rect: element.getBoundingClientRect() });
      }, delay);
    };

    const over = (event: MouseEvent) => {
      const element = tipped(event.target);
      if (element) show(element, open.current ? NEXT_MS : DELAY_MS);
      else hide();
    };

    /** Pressing a control that cannot act answers with its reason at once. */
    const press = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[aria-disabled="true"][data-tip]') : null;
      if (element) show(element, 0);
    };

    /** Holding a modifier is not typing, so a tip that names a shortcut stays while its keys are found. */
    const key = (event: KeyboardEvent) => {
      if (!MODIFIERS.has(event.key)) hide();
    };

    const focus = (event: FocusEvent) => {
      const element = tipped(event.target);
      /** Focus reached by keyboard explains itself; a click already said what the control does. */
      if (element && keyboardFocusVisible()) show(element, 0);
      else hide();
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("click", press);
    document.addEventListener("keydown", key, true);
    /** A tooltip names a place on screen, so anything that moves that place takes it away. */
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("click", press);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      if (timer.current) clearTimeout(timer.current);
      release();
    };
  }, [id]);

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
  return createPortal(<div className="tooltip" role="tooltip" id={id} ref={box}>{tip.text}</div>, document.body);
}
