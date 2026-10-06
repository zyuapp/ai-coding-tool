import { LuCornerDownRight as CornerDownRight, LuPencil as Pencil, LuX as X } from "react-icons/lu";
import type { QueuedMessage } from "../../application/workspace-state";
import { messageLabel } from "../../domain/message-origin";
import { AnnotationRow } from "./AnnotationRow";
import type { ComposerSurface } from "./ConversationComposer";

function QueuedOrigin({ message }: { message: QueuedMessage }) {
  const label = messageLabel(message);
  return label ? <p className="queued-origin">{label}</p> : null;
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
            {message.text && <p className="queued-text">{message.text}</p>}
            {message.annotations?.length ? <AnnotationRow annotations={message.annotations} /> : null}
          </div>
          {message.steering ? <span className="queued-state">Steering…</span> : (
            <span className="queued-actions">
              {!messageLabel(message) && (
                <button type="button" className="queued-edit" aria-label="Edit queued message" title="Edit" onClick={() => onEdit(message.id)}>
                  <Pencil size={13} />
                </button>
              )}
              {canSteer && <button type="button" className="queued-steer" onClick={() => onSteer(message.id)}>Steer</button>}
              <button type="button" className="queued-drop" aria-label="Remove queued message" onClick={() => onDrop(message.id)}>
                <X size={13} />
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
