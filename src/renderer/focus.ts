import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

type ElementRef = RefObject<HTMLElement | null>;

const FOCUSABLE = 'button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function restoreFocus(element: HTMLElement | null) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (element?.isConnected && (!active || active === document.body || !active.isConnected)) element.focus();
  });
}

/** Closes a transient layer from one pointer press or Escape, then returns abandoned focus. */
export function useDismissibleLayer(open: boolean, roots: ElementRef[], onDismiss: () => void, returnFocus?: ElementRef | null) {
  const latest = useRef({ roots, onDismiss });
  latest.current = { roots, onDismiss };

  useEffect(() => {
    if (!open) return;
    const fallback = returnFocus === null ? null : returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const pointerDown = (event: PointerEvent) => {
      if (!latest.current.roots.some((ref) => ref.current?.contains(event.target as Node))) latest.current.onDismiss();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      latest.current.onDismiss();
    };
    const blur = () => latest.current.onDismiss();
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
      window.removeEventListener("blur", blur);
      restoreFocus(fallback);
    };
  }, [open, returnFocus]);
}

/** Focuses a temporary view on entry and hands focus back when it leaves. */
export function useFocusReturn(initialFocus?: ElementRef) {
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (document.activeElement !== initialFocus?.current) previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus?.current?.focus();
    return () => restoreFocus(previous.current);
  }, [initialFocus]);
}

/** Keeps keyboard focus inside a true modal and makes the rest of the document inert. */
export function useModalFocus(root: ElementRef) {
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = root.current;
    if (!dialog) return;
    if (!dialog.contains(document.activeElement)) previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const outside = [...document.body.children].filter((element) => element !== dialog).map((element) => ({ element: element as HTMLElement, inert: (element as HTMLElement).inert }));
    outside.forEach(({ element }) => { element.inert = true; });

    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
    (focusables()[0] ?? dialog).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      outside.forEach(({ element, inert }) => { element.inert = inert; });
      restoreFocus(previous.current);
    };
  }, [root]);
}

/** Arrow keys move among the buttons in a menu while search fields keep normal text keys. */
export function moveListFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (!buttons.length) return;
  event.preventDefault();
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
}
