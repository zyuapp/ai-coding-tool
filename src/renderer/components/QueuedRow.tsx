import { LuCornerDownRight as CornerDownRight, LuX as X } from "react-icons/lu";
import type { QueuedMessage } from "../../application/workspace-state";
import { AnnotationRow } from "./AnnotationRow";

/** Messages waiting on the run, each with what it carries and the two things you can do to it. */
export function QueuedRow({ messages, surface, onSteer, onDrop }: {
  messages: QueuedMessage[];
  surface: "main" | "side";
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
            {message.text && <p className="queued-text">{message.text}</p>}
            {message.annotations?.length ? <AnnotationRow annotations={message.annotations} /> : null}
          </div>
          {message.steering ? <span className="queued-state">Steering…</span> : (
            <span className="queued-actions">
              <button type="button" className="queued-steer" onClick={() => onSteer(message.id)}>Steer</button>
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
