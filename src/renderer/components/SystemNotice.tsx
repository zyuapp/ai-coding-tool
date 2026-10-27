import { LuCircleAlert as CircleAlert } from "react-icons/lu";
import type { ConversationMessage } from "../../domain/conversation";

/** A state change the workspace made on its own: a worktree move, a compaction, or a run that failed. */
export function SystemNotice({ message }: { message: ConversationMessage }) {
  const error = message.tone === "error";
  return (
    <article className={`message system${error ? " error" : ""}`}>
      <div className="message-text">{error && <CircleAlert className="notice-icon" aria-hidden="true" />}{message.text}</div>
      {message.detail && <div className="message-detail">{message.detail}</div>}
    </article>
  );
}
