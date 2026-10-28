import { LuArchive as Archive } from "react-icons/lu";
import { ARCHIVE_RETENTION_MS } from "../../domain/thread-retention";
import type { Thread } from "../../domain/thread";
import { ConfirmAction } from "./SettingRow";

export type ArchiveSettingsProps = {
  archivedThreads: Thread[];
  onRestoreThread: (threadId: string) => void;
  onClearArchive: () => void;
};

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export function ArchiveSettings({ archivedThreads, onRestoreThread, onClearArchive }: ArchiveSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Archived threads</h2>
        <p>Archived threads stay here for 5 days, then AI Coding Tool deletes them on the next launch.</p>
      </div>

      <section className="settings-group" aria-labelledby="archive-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="archive-heading">Archive</h3>
            <p>Restore a thread to put it back in the sidebar. Its automation stays off.</p>
          </div>
          <div className="settings-group-action">
            <span>{archivedThreads.length} archived</span>
            {archivedThreads.length > 0 && <ConfirmAction confirm="Delete all" onConfirm={onClearArchive}>Clear all</ConfirmAction>}
          </div>
        </div>

        {archivedThreads.length === 0
          ? <p className="settings-empty">Nothing archived.</p>
          : archivedThreads.map((thread) => (
            <div className="setting-row" key={thread.id}>
              <span className="setting-status archived" aria-hidden="true"><Archive size={14} /></span>
              <div>
                <strong>{thread.title}</strong>
                <p>{daysLeft(thread.archivedAt!)}</p>
              </div>
              <div className="setting-row-action">
                <button type="button" onClick={() => onRestoreThread(thread.id)}>Restore</button>
              </div>
            </div>
          ))}
      </section>
    </main>
  );
}
