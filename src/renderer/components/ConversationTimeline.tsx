import { ListCollapse, type LucideIcon } from "lucide-react";
import type { Task } from "../../domain/task";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

export type ConversationTimelineProps = {
  currentTask?: Task;
  folder: string;
  status: "idle" | "running" | "stopped";
  compacting: boolean;
  empty?: { icon: LucideIcon; title: string; description: string };
};

export function ConversationTimeline({ currentTask, folder, status, compacting, empty }: ConversationTimelineProps) {
  if (!currentTask?.messages.length) {
    const EmptyIcon = empty?.icon;
    return (
      <div className="empty-state">
        <div className="empty-glyph">{EmptyIcon ? <EmptyIcon /> : <FolderIcon />}</div>
        <h2>{empty?.title ?? "Start a task"}</h2>
        <p>{empty?.description ?? (folder ? "Tell Claude what you want to change, investigate, or build in this project." : "Ask a question or start a self-contained task.")}</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {currentTask.messages.map((message) => (
        <article className={`message ${message.kind}`} key={message.id}>
          {message.kind === "tool" ? (
            <details className="work-row">
              <summary><span>Worked</span><span>{message.text}</span></summary>
              <pre>{message.detail}</pre>
            </details>
          ) : (
            <div className="message-text">{message.text}</div>
          )}
        </article>
      ))}
      {status === "running" && compacting && (
        <div className="compacting-row" role="status" aria-live="polite">
          <ListCollapse aria-hidden="true" />
          <span>Compacting messages…</span>
          <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      {status === "running" && !compacting && (
        <div className="thinking-row">
          <span /> <span /> <span />
        </div>
      )}
    </div>
  );
}
