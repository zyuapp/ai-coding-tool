import type { IconType } from "react-icons";
import { LuMessageCircle } from "react-icons/lu";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

type EmptyStateProps = {
  /** False while the stored threads are still on their way, when an empty transcript means nothing. */
  restored: boolean;
  empty?: { icon: IconType; title: string; description: string };
  /** What a new thread's transcript names: its project, or that it is a chat. */
  place?: string;
};

export function TimelineEmptyState({ restored, empty, place }: EmptyStateProps) {
  /** A transcript that has nothing yet because nothing has been read is not a transcript with nothing in it. */
  if (!restored) return <div className="empty-state" />;
  if (empty) {
    const EmptyIcon = empty.icon;
    return (
      <div className="empty-state">
        <div className="empty-glyph"><EmptyIcon /></div>
        <h2>{empty.title}</h2>
        <p>{empty.description}</p>
      </div>
    );
  }
  /** Where the thread will work is all a new one needs to say; the composer under it asks the rest. */
  return (
    <div className="empty-state empty-place">
      <div className="empty-glyph">{place ? <FolderIcon /> : <LuMessageCircle />}</div>
      <h2>{place ?? "New chat"}</h2>
    </div>
  );
}
