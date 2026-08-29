import { LuArchive as Archive } from "react-icons/lu";
import { ARCHIVE_RETENTION_MS } from "../../domain/thread-retention";
import type { Thread } from "../../domain/thread";

export type ArchiveSettingsProps = {
  archivedTasks: Thread[];
  /** Whether deleting every archived thread is one press away from happening. */
  confirming: boolean;
  confirmationRef: React.RefObject<HTMLButtonElement | null>;
  clearRef: React.RefObject<HTMLButtonElement | null>;
  onRestoreTask: (taskId: string) => void;
  onClearArchive: () => void;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
};

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export function ArchiveSettings({
  archivedTasks,
  confirming,
  confirmationRef,
  clearRef,
  onRestoreTask,
  onClearArchive,
  onStartConfirm,
  onCancelConfirm,
}: ArchiveSettingsProps) {
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
            <span>{archivedTasks.length} archived</span>
            {archivedTasks.length > 0 && (confirming
              ? <>
                  <button ref={confirmationRef} className="danger" type="button" onClick={() => {
                    onClearArchive();
                    onCancelConfirm();
                  }}>Delete all</button>
                  <button type="button" onClick={onCancelConfirm}>Cancel</button>
                </>
              : <button ref={clearRef} type="button" onClick={onStartConfirm}>Clear all</button>)}
          </div>
        </div>

        {archivedTasks.length === 0
          ? <p className="settings-empty">Nothing archived.</p>
          : archivedTasks.map((task) => (
            <div className="setting-row" key={task.id}>
              <span className="setting-status archived"><Archive size={13} /></span>
              <div>
                <strong>{task.title}</strong>
                <p>{daysLeft(task.archivedAt!)}</p>
              </div>
              <div className="setting-row-action">
                <button type="button" onClick={() => onRestoreTask(task.id)}>Restore</button>
              </div>
            </div>
          ))}
      </section>
    </main>
  );
}
