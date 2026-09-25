import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The one shape every menu on the phone takes: a card that rises from the bottom edge under a
 * scrim, leaves when tapped away, and gives focus back to what opened it once it is gone.
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

  /** Focus lands on the chosen option and goes back to where it came from once the sheet is gone. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = sheet.current;
    const chosen = node?.querySelector<HTMLElement>('[aria-checked="true"], input, textarea');
    (chosen ?? node)?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, []);

  function close() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) onClose();
    else setClosing(true);
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
      }}
    >
      <div ref={sheet} className="sheet" tabIndex={-1} onClick={(event) => event.stopPropagation()} onAnimationEnd={() => closing && onClose()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          {action ?? <button type="button" className="sheet-done" onClick={close}>Done</button>}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
