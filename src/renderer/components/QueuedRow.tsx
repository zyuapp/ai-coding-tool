import { LuChevronDown as ChevronDown, LuCornerDownRight as CornerDownRight, LuPencil as Pencil, LuX as X } from "react-icons/lu";
import type { QueuedMessage } from "../../application/workspace-state";
import { isUsersOwn, messageLabel } from "../../domain/message-origin";
import { useState, type KeyboardEvent } from "react";
import { AnnotationRow, useClamped } from "./AnnotationRow";
import type { ComposerSurface } from "./ConversationComposer";
import { ConfirmAction } from "./SettingRow";

function QueuedOrigin({ message }: { message: QueuedMessage }) {
  const label = messageLabel(message);
  return label ? <p className="queued-origin">{label}</p> : null;
}

/** A queued message's words on one line, opened out in place when they run past it. */
function QueuedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [ref, cut] = useClamped<HTMLParagraphElement>(text);
  const toggles = cut || open;
  return (
    <div
      className={`queued-text${open ? " open" : ""}${toggles ? " toggles" : ""}`}
      {...(toggles ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(!open);
        },
      } : {})}
    >
      <p ref={ref}>{text}</p>
      {toggles && <ChevronDown className="queued-chevron" size={14} aria-hidden="true" />}
    </div>
  );
}

/** Messages waiting on the run, each with what it carries and what you can do to it. */
export function QueuedRow({ messages, surface, canSteer, onEdit, onSteer, onDrop }: {
  messages: QueuedMessage[];
  surface: ComposerSurface;
  /** Only a run that is going can take a message early; one held for a usage limit waits for it to lift. */
  canSteer: boolean;
  onEdit: (messageId: string) => void;
  onSteer: (messageId: string) => void;
  onDrop: (messageId: string) => void;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="queued-row" role="list" aria-label={surface === "side" ? "Queued side chat messages" : "Queued messages"}>
      {messages.map((message) => (
        <div className="queued-message" role="listitem" key={message.id}>
          <CornerDownRight className="queued-mark" size={14} aria-hidden="true" />
          <div className="queued-body">
            <QueuedOrigin message={message} />
            {message.text && <QueuedText text={message.text} />}
            {message.annotations?.length ? <AnnotationRow annotations={message.annotations} /> : null}
          </div>
          {message.steering ? <span className="queued-state">Steering…</span> : (
            <span className="queued-actions">
              {isUsersOwn(message) && (
                <button type="button" className="queued-edit" aria-label="Edit queued message" data-tip="Edit" onClick={() => onEdit(message.id)}>
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="queued-steer"
                aria-disabled={!canSteer || undefined}
                data-tip={canSteer ? "Send now, into the running turn" : "Steer once the run resumes"}
                onClick={() => { if (canSteer) onSteer(message.id); }}
              >
                Steer
              </button>
              <ConfirmAction className="queued-drop" aria-label="Remove queued message" data-tip="Remove" confirm="Remove" onConfirm={() => onDrop(message.id)}>
                <X size={14} aria-hidden="true" />
              </ConfirmAction>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
