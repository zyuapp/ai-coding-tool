import type { IconType } from "react-icons";
import { SweepBand } from "./SweepBand";

type EmptyStateProps = {
  /** False while the stored threads are still on their way, when an empty transcript means nothing. */
  restored: boolean;
  empty?: { icon: IconType; title: string; description: string };
  /** The engine a new thread's transcript asks work for. */
  engineLabel: string;
};

export function TimelineEmptyState({ restored, empty, engineLabel }: EmptyStateProps) {
  /** A transcript that has nothing yet because nothing has been read is not a transcript with nothing in it. */
  if (!restored) return <div className="empty-state" role="status"><span className="empty-loading text-sweep">Loading threads…<SweepBand>Loading threads…</SweepBand></span></div>;
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
  /** A new thread asks one thing; the composer under it takes the answer and says where it will work. */
  return (
    <div className="empty-state empty-place">
      <h2>What should {engineLabel} work on?</h2>
    </div>
  );
}
