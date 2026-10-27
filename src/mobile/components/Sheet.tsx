import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/** How far the head is pulled down before letting go closes the sheet rather than springing it back. */
const PULL_TO_CLOSE_PX = 80;

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The one shape every menu on the phone takes: a card that rises from the bottom edge under a
 * scrim, leaves when tapped away or pulled down by its head, keeps Tab inside it while it is up,
 * and gives focus back to what opened it once it is gone.
 */
export function Sheet({ title, label, action, children, onClose }: {
  title: string;
  /** What the dialog is called for a reader, when the title alone does not say. */
  label?: string;
  /** The button in the head's right corner. "Done" unless the sheet has something else to offer. */
  action?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  /** Set once close is asked for; the sheet leaves when its exit animation ends. */
  const [closing, setClosing] = useState(false);
  /** Where a pull on the head started, and how far down the sheet now follows it. */
  const pull = useRef<number | null>(null);
  const [pulled, setPulled] = useState(0);

  /**
   * Focus lands on the chosen option, or else the field to type in, and goes back to where it came
   * from once the sheet is gone. A sheet that lists choices does not raise the keyboard over them.
   */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = sheet.current;
    const chosen = node?.querySelector<HTMLElement>('[aria-checked="true"]') ?? node?.querySelector<HTMLElement>("input, textarea");
    (chosen ?? node)?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, []);

  function close() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) onClose();
    else setClosing(true);
  }

  function keepTabInside(event: KeyboardEvent) {
    const node = sheet.current;
    if (event.key !== "Tab" || !node) return;
    const stops = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const [first, last] = [stops[0], stops.at(-1)];
    if (!first || !last) return;
    const active = document.activeElement;
    const wrapTo = !node.contains(active) || active === node
      ? (event.shiftKey ? last : first)
      : event.shiftKey && active === first ? last : !event.shiftKey && active === last ? first : null;
    if (!wrapTo) return;
    event.preventDefault();
    wrapTo.focus();
  }

  function startPull(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("button")) return;
    pull.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePull(event: PointerEvent) {
    if (pull.current !== null) setPulled(Math.max(0, event.clientY - pull.current));
  }

  function endPull() {
    if (pull.current === null) return;
    pull.current = null;
    if (pulled > PULL_TO_CLOSE_PX) close();
    else setPulled(0);
  }

  /** The exit animation says when the sheet is gone; a browser that draws none is not allowed to keep it. */
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, 240);
    return () => clearTimeout(timer);
  }, [closing, onClose]);

  return (
    <div
      className={closing ? "scrim closing" : "scrim"}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
        keepTabInside(event);
      }}
    >
      <div
        ref={sheet}
        className="sheet"
        tabIndex={-1}
        data-pulled={pulled > 0 || undefined}
        style={pulled > 0 ? { transform: `translateY(${pulled}px)` } : undefined}
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={() => closing && onClose()}
      >
        <div className="sheet-head" onPointerDown={startPull} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull}>
          <h2>{title}</h2>
          {action ?? <button type="button" className="sheet-done" onClick={close}>Done</button>}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
