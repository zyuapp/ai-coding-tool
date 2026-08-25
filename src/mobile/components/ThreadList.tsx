import type { MobileProjectGroup, MobileThreadEntry } from "../../contracts/mobile";
import { relativeTime, statusLabel } from "../format";

function ThreadRow({ thread, now, onOpen }: { thread: MobileThreadEntry; now: number; onOpen: () => void }) {
  return (
    <button type="button" className="thread-row" data-status={thread.status} onClick={onOpen}>
      <span className="thread-mark" aria-hidden="true" />
      <span className="thread-body">
        <span className="thread-title">{thread.title || "Untitled thread"}</span>
        <span className="thread-meta">
          <span className="thread-status">{statusLabel(thread.status)}</span>
          <span className="thread-when">{relativeTime(thread.lastActivityAt, now)}</span>
        </span>
      </span>
      {thread.unread && <span className="thread-unread" aria-label="Unread" />}
    </button>
  );
}

export function ThreadList({ groups, now, onOpen, onNew }: {
  groups: MobileProjectGroup[];
  now: number;
  onOpen: (threadId: string) => void;
  onNew: (projectId: string | null) => void;
}) {
  if (!groups.some((group) => group.threads.length)) {
    return (
      <div className="empty">
        <p>No threads yet.</p>
        <button type="button" className="primary wide" onClick={() => onNew(null)}>Start a thread</button>
      </div>
    );
  }
  return (
    <div className="thread-list">
      {groups.map((group) => (
        <section key={group.projectId ?? "recents"} className="thread-group">
          <header className="group-header">
            <h2>{group.name}</h2>
            <button type="button" className="ghost small" onClick={() => onNew(group.projectId)} aria-label={`New thread in ${group.name}`}>New</button>
          </header>
          {group.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} now={now} onOpen={() => onOpen(thread.id)} />
          ))}
        </section>
      ))}
    </div>
  );
}
