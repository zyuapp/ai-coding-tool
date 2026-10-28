import { useEffect, useRef, useState } from "react";
import { LuCircleAlert as Alert, LuCircleCheck as Check, LuDownload as Download, LuLoaderCircle as Loader, LuX as X } from "react-icons/lu";
import type { Toast, ToastAction, ToastTone } from "../../domain/toast";

const ICONS: Record<ToastTone, typeof Check> = { update: Download, progress: Loader, success: Check, error: Alert };

/** A command wraps only between its words, so a flag is never split from its dash. */
function Command({ text }: { text: string }) {
  return <code>{text.split(/(\s+)/).map((word, index) => index % 2 ? word : <span key={index}>{word}</span>)}</code>;
}

/** A message with its commands in backticks, which read as code so they can be picked out and typed. */
function ToastMessage({ text }: { text: string }) {
  return <p>{text.split("`").map((part, index) => index % 2 ? <Command key={index} text={part} /> : part)}</p>;
}

type ToastsProps = {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
  onAction: (command: ToastAction["command"]) => void;
};

/**
 * The cards in the window's top-right corner, newest on top. Each leaves on its own, or at its X.
 * While the pointer or caret is on the cards, one whose time runs out stays until both have left.
 */
export function Toasts({ toasts, onDismiss, onAction }: ToastsProps) {
  const section = useRef<HTMLElement>(null);
  const holding = useRef({ pointer: false, focus: false, held: false });
  const [held, setHeld] = useState(false);
  const [kept, setKept] = useState<readonly Toast[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const [previous, setPrevious] = useState(toasts);
  if (previous !== toasts) {
    setPrevious(toasts);
    const left = held ? previous.filter((toast) => !closed.has(toast.id) && !toasts.some((item) => item.id === toast.id)) : [];
    if (left.length) setKept([...kept, ...left]);
  }
  const shown = kept.length ? [...toasts, ...kept].sort((a, b) => a.id - b.id) : toasts;
  const hold = (change: Partial<{ pointer: boolean; focus: boolean }>) => {
    const next = { ...holding.current, ...change };
    const nowHeld = next.pointer || next.focus;
    holding.current = { ...next, held: nowHeld };
    if (nowHeld === next.held) return;
    setHeld(nowHeld);
    if (!nowHeld) { setKept([]); setClosed(new Set()); }
  };
  /** A card closed under the pointer or the caret can take the hold with it, since nothing then says it left. */
  useEffect(() => {
    const within = (element: Element | null) => Boolean(element && section.current?.contains(element));
    if (holding.current.held) hold({ pointer: within(document.querySelector(".toasts:hover")), focus: within(document.activeElement) });
  });
  /** Closing the card that holds the caret hands it to the card that takes its place, so the keyboard is not dropped. */
  const dismiss = (id: number, card: HTMLElement) => {
    if (card.contains(document.activeElement)) {
      const cards = [...(section.current?.querySelectorAll<HTMLElement>(".toast") ?? [])];
      const index = cards.indexOf(card);
      (cards[index + 1] ?? cards[index - 1])?.querySelector<HTMLElement>(".toast-close")?.focus();
    }
    if (held) setClosed(new Set(closed).add(id));
    setKept(kept.filter((toast) => toast.id !== id));
    onDismiss(id);
  };
  if (!shown.length) return null;
  return (
    <section
      ref={section}
      className="toasts"
      aria-label="Notifications"
      onMouseEnter={() => hold({ pointer: true })}
      onMouseLeave={() => hold({ pointer: false })}
      onFocus={() => hold({ focus: true })}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hold({ focus: false }); }}
    >
      {[...shown].reverse().map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            className={`toast ${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              dismiss(toast.id, event.currentTarget);
            }}
          >
            <Icon className="toast-icon" size={16} aria-hidden="true" />
            <div className="toast-text">
              <strong>{toast.title}</strong>
              {toast.message && <ToastMessage text={toast.message} />}
              {toast.action && <button type="button" className="toast-action" onClick={() => onAction(toast.action!.command)}>{toast.action.label}</button>}
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss" data-tip="Dismiss" onClick={(event) => dismiss(toast.id, event.currentTarget.closest<HTMLElement>(".toast")!)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
