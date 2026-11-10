import { memo, useMemo } from "react";
import { recentIn } from "../../application/thread-order";
import { projectName, type Project } from "../../domain/project";
import { recencyLabel } from "../../domain/recency";
import type { Thread } from "../../domain/thread";
import { ListHeading, ListRow } from "../ui/List";

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
        <ListHeading label={heading} role="heading" aria-level={3} />
        {recent.map((thread) => (
          <ListRow
            key={thread.id}
            plain
            title={thread.title}
            trailing={<time dateTime={new Date(thread.rankedAt).toISOString()}>{recencyLabel(thread.rankedAt, now)}</time>}
            onClick={() => onSelect(thread.id)}
          />
        ))}
      </div>
    </nav>
  );
});
