import { memo, useMemo } from "react";
import { recentIn } from "../../application/thread-order";
import { projectName, type Project } from "../../domain/project";
import { recencyLabel } from "../../domain/recency";
import type { Thread } from "../../domain/thread";

const SHOWN = 4;

/**
 * The threads last active where a new thread is about to start, each a click away, so one already
 * on the subject is picked up rather than started again.
 */
export const DraftRecents = memo(function DraftRecents({ threads, project, onSelect }: {
  threads: readonly Thread[];
  /** Where the new thread starts, or nothing for a chat. */
  project: Project | null | undefined;
  onSelect: (threadId: string) => void;
}) {
  const recent = useMemo(() => recentIn(threads, project?.id, SHOWN), [threads, project?.id]);
  if (recent.length === 0) return null;
  const heading = project ? `Recent in ${projectName(project)}` : "Recent chats";
  const now = Date.now();
  return (
    <nav className="draft-recents" aria-label={heading}>
      <div>
        <h3>{heading}</h3>
        {recent.map((thread) => (
          <button key={thread.id} type="button" onClick={() => onSelect(thread.id)}>
            <span>{thread.title}</span>
            <time dateTime={new Date(thread.rankedAt).toISOString()}>{recencyLabel(thread.rankedAt, now)}</time>
          </button>
        ))}
      </div>
    </nav>
  );
});
