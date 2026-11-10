import { LuX as X } from "react-icons/lu";
import { useEffect, useId, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";
import { shortcutTip } from "../components/TooltipLayer";
import { IconButton } from "./Button";
import "./glass.css";
import "./dialog.css";

const joined = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base);

/** Escape answers the topmost layer only: caught before anything else hears it, so it never reaches the window's own Escape. */
function useEscape(onEscape: () => void) {
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    }
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onEscape]);
}

export type DialogProps = {
  /** The accessible name. Defaults to the title. */
  label?: string;
  title?: ReactNode;
  /** Cancel: a press on the backdrop, and Escape unless `onEscape` is given. */
  onClose: () => void;
  /** Escape, where it means more than closing, such as first folding an open list. */
  onEscape?: () => void;
  /** Takes the focus on entry instead of the first control; a text field also has its text selected. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  /** A form submits on Enter; `onSubmit` runs with the default already prevented. */
  as?: "div" | "form";
  onSubmit?: () => void;
  /** Drawn edge to edge above the title. */
  media?: ReactNode;
  /** The answers, laid out as the footer. */
  actions?: ReactNode;
  children?: ReactNode;
  /** The panel: the form, when it is one. */
  ref?: Ref<HTMLElement>;
  "aria-describedby"?: string;
  "aria-busy"?: boolean;
};

/** One modal over the window: focus held inside, the rest inert, closed by Escape or the backdrop. */
export function Dialog({ label, title, onClose, onEscape, initialFocus, className, as = "div", onSubmit, media, actions, children, ref, "aria-describedby": describedBy, "aria-busy": busy }: DialogProps) {
  const scrim = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(scrim);
  useEscape(onEscape ?? onClose);
  useEffect(() => {
    const target = initialFocus?.current;
    if (!target) return;
    target.focus();
    if (target.tagName === "INPUT") (target as HTMLInputElement).select();
  }, [initialFocus]);

  const Panel = as;
  const named = label === undefined && title !== undefined;
  return createPortal(
    <div
      ref={scrim}
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={named ? titleId : undefined}
      aria-describedby={describedBy}
      tabIndex={-1}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <Panel
        ref={ref as Ref<HTMLDivElement & HTMLFormElement>}
        className={joined("glass-overlay dialog", className)}
        aria-busy={busy || undefined}
        onSubmit={as === "form" ? (event: { preventDefault: () => void }) => { event.preventDefault(); onSubmit?.(); } : undefined}
      >
        {media !== undefined && <div className="dialog-media">{media}</div>}
        {title !== undefined && <h2 id={titleId} className="dialog-title">{title}</h2>}
        {children}
        {actions !== undefined && <div className="dialog-actions">{actions}</div>}
      </Panel>
    </div>,
    document.body,
  );
}

export type ViewerProps = {
  label: string;
  className?: string;
  /** Controls drawn over the view beside the close button, such as zoom. */
  controls?: ReactNode;
  onClose: () => void;
  /** Keys other than Escape anywhere in the window while the viewer is open, such as arrows that step through a gallery. */
  onKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
};

/** A block over the whole window, closed by Escape, its close button, or a press and release on the backdrop. */
export function Viewer({ label, className, controls, onClose, onKeyDown, children }: ViewerProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const pressedOn = useRef<EventTarget | null>(null);
  useModalFocus(dialog);
  useEscape(onClose);
  useEffect(() => {
    if (!onKeyDown) return;
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return createPortal(
    <div
      ref={dialog}
      className={joined("viewer", className)}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onPointerDown={(event) => { pressedOn.current = event.target; }}
      onClick={(event) => { if (event.target === pressedOn.current) onClose(); }}
    >
      {controls}
      <IconButton className="viewer-close" variant="soft" size="md" label={`Close ${label.toLowerCase()}`} tip={shortcutTip("Close", "Escape")} onClick={onClose}><X size={16} /></IconButton>
      {children}
    </div>,
    document.body,
  );
}
