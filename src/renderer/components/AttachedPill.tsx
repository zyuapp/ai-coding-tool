import { LuX as X } from "react-icons/lu";
import type { ReactNode } from "react";
import "../ui/tone.css";
import "./attached-pill.css";

/** A row of what rides a message, as pills: removable while drafted in a composer, read-only once sent. */
export function AttachedRow({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return <div className={`attached-row ${className}`} role="list" aria-label={label}>{children}</div>;
}

/**
 * One pill: its face, given as children with the class `attached-pill-face`, then a remove button
 * while `onRemove` is set. `after` is drawn last, for a card the pill raises.
 */
export function AttachedPill({ className, tone, removeLabel, removeClassName, onRemove, after, children }: {
  className: string;
  tone?: "info" | undefined;
  removeLabel: string;
  removeClassName: string;
  onRemove?: (() => void) | undefined;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={`attached-pill ${className}`} role="listitem" data-tone={tone}>
      {children}
      {onRemove && (
        <button type="button" className={`attached-pill-remove ${removeClassName}`} aria-label={removeLabel} data-tip="Remove" onClick={onRemove}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {after}
    </span>
  );
}
