import { LuSearch as Search } from "react-icons/lu";
import { useRef, useState } from "react";
import { ARCHIVE_RETENTION_MS } from "../../domain/thread-retention";
import type { Thread } from "../../domain/thread";
import { ConfirmAction } from "./SettingRow";

export type ArchiveSettingsProps = {
  archivedThreads: Thread[];
  onRestoreThread: (threadId: string) => void;
  onClearArchive: () => void;
};

/** How many archived threads the page lists before it offers a filter. */
export const ARCHIVE_FILTER_FROM = 8;

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export function ArchiveSettings({ archivedThreads, onRestoreThread, onClearArchive }: ArchiveSettingsProps) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const filtering = archivedThreads.length > ARCHIVE_FILTER_FROM;
  const term = filtering ? query.trim().toLowerCase() : "";
  const shown = term ? archivedThreads.filter((thread) => thread.title.toLowerCase().includes(term)) : archivedThreads;
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
            {archivedThreads.length > 0 && <ConfirmAction className="danger" confirm="Delete all" onConfirm={onClearArchive}>Clear all</ConfirmAction>}
          </div>
        </div>

        {filtering && (
          <label className="settings-filter">
            <Search size={14} aria-hidden="true" />
            <input
              ref={field}
              type="search"
              value={query}
              placeholder="Filter archived threads"
              aria-label="Filter archived threads"
              spellCheck={false}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !query) return;
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }}
            />
          </label>
        )}

        {archivedThreads.length === 0
          ? <p className="settings-empty">Nothing archived.</p>
          : shown.length === 0
            ? <p className="settings-empty">No archived thread matches “{query.trim()}”. <button type="button" className="settings-empty-action" onClick={() => { setQuery(""); field.current?.focus(); }}>Clear filter</button></p>
            : shown.map((thread) => (
              <div className="setting-row plain" key={thread.id}>
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
