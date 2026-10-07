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

/** The cards in the window's top-right corner, newest on top. Each leaves on its own, or at its X. */
export function Toasts({ toasts, onDismiss, onAction }: { toasts: readonly Toast[]; onDismiss: (id: number) => void; onAction: (command: ToastAction["command"]) => void }) {
  if (!toasts.length) return null;
  return (
    <section className="toasts" aria-label="Notifications">
      {[...toasts].reverse().map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
            <Icon className="toast-icon" size={16} aria-hidden="true" />
            <div className="toast-text">
              <strong>{toast.title}</strong>
              {toast.message && <ToastMessage text={toast.message} />}
              {toast.action && <button type="button" className="toast-action" onClick={() => onAction(toast.action!.command)}>{toast.action.label}</button>}
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
