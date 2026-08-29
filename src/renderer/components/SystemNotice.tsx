import type { ConversationMessage } from "../../domain/conversation";

/** A state change the workspace made on its own: a worktree move, a compaction, or a run that failed. */
export function SystemNotice({ message }: { message: ConversationMessage }) {
  return (
    <article className={`message system${message.tone === "error" ? " error" : ""}`}>
      <div className="message-text">{message.text}</div>
      {message.detail && <div className="message-detail">{message.detail}</div>}
    </article>
  );
}
