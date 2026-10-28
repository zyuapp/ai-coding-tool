import { useEffect, useRef, useState } from "react";
import { LuCircleAlert as Alert, LuCircleCheck as Check, LuDownload as Download, LuLoaderCircle as Loader, LuX as X } from "react-icons/lu";
import { MAX_TOASTS, type Toast, type ToastAction, type ToastTone } from "../../domain/toast";

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

const NONE: ReadonlySet<number> = new Set();

/** While the cards are held, one whose time ran out stays until the user lets go or closes it. */
function heldToasts(previous: readonly Toast[], toasts: readonly Toast[], closed: ReadonlySet<number>) {
  const present = new Set(toasts.map((toast) => toast.id));
  const left = previous.filter((toast) => !present.has(toast.id));
  if (!left.length && !closed.size) return toasts;
  return [...left, ...toasts].filter((toast) => !closed.has(toast.id)).sort((a, b) => a.id - b.id).slice(-MAX_TOASTS);
}

/**
 * The cards in the window's top-right corner, newest on top. Each leaves on its own, or at its X, but
 * none leaves while the pointer or the caret is on the cards.
 */
export function Toasts({ toasts, onDismiss, onAction }: ToastsProps) {
  const section = useRef<HTMLElement>(null);
  const holding = useRef({ pointer: false, focus: false });
  const [held, setHeld] = useState(false);
  const [closed, setClosed] = useState(NONE);
  const shown = useRef(toasts);
  const list = held ? heldToasts(shown.current, toasts, closed) : toasts;
  shown.current = list;
  const hold = (change: Partial<{ pointer: boolean; focus: boolean }>) => {
    holding.current = { ...holding.current, ...change };
    const next = holding.current.pointer || holding.current.focus;
    setHeld(next);
    if (!next) setClosed(NONE);
  };
  /** A card closed under the pointer or the caret can take the hold with it, since nothing then says it left. */
  const count = useRef(list.length);
  useEffect(() => {
    const shrank = list.length < count.current;
    count.current = list.length;
    if (!shrank || !held) return;
    const within = (element: Element | null) => Boolean(element && section.current?.contains(element));
    hold({ pointer: within(document.querySelector(".toasts:hover")), focus: within(document.activeElement) });
  });
  /** Closing the card that holds the caret hands it to the card that takes its place, so the keyboard is not dropped. */
  const dismiss = (id: number, card: HTMLElement) => {
    if (card.contains(document.activeElement)) {
      const cards = [...(section.current?.querySelectorAll<HTMLElement>(".toast") ?? [])];
      const index = cards.indexOf(card);
      (cards[index + 1] ?? cards[index - 1])?.querySelector<HTMLElement>(".toast-close")?.focus();
    }
    if (held) setClosed((ids) => new Set([...ids, id]));
    onDismiss(id);
  };
  if (!list.length) return null;
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
      {[...list].reverse().map((toast) => {
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
