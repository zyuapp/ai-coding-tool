import { LuCircleAlert as CircleAlert, LuInfo as Info } from "react-icons/lu";
import type { ConversationMessage } from "../../domain/conversation";
import "../ui/glass.css";
import { CopyButton } from "./CopyButton";

/** A state change the workspace made on its own: a worktree move, a compaction, or a run that failed. */
export function SystemNotice({ message }: { message: ConversationMessage }) {
  const error = message.tone === "error";
  const Icon = error ? CircleAlert : Info;
  return (
    <article className={`message system glass-chip${error ? " error" : ""}`} data-tone={error ? "danger" : undefined}>
      <div className="message-text"><Icon className="notice-icon" aria-hidden="true" />{message.text}</div>
      {message.detail && <div className="message-detail">{message.detail}</div>}
      {error && <CopyButton text={message.detail ? `${message.text}\n${message.detail}` : message.text} label="Copy the error" />}
    </article>
  );
}
