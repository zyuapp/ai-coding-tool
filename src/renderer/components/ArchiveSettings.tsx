import { LuSearch as Search } from "react-icons/lu";
import { useRef, useState } from "react";
import { ARCHIVE_RETENTION_MS } from "../../domain/thread-retention";
import type { Thread } from "../../domain/thread";
import { projectName, type Project } from "../../domain/project";
import { ConfirmAction, useRowListFocus } from "./SettingRow";

export type ArchiveSettingsProps = {
  archivedThreads: Thread[];
  /** The projects archived threads may belong to, so each row can say which one. */
  projects?: readonly Project[];
  onRestoreThread: (threadId: string) => void;
  onClearArchive: () => void;
};

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export function ArchiveSettings({ archivedThreads, projects = [], onRestoreThread, onClearArchive }: ArchiveSettingsProps) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const rows = useRowListFocus<HTMLElement>();
  const [restored, setRestored] = useState<string | null>(null);
  const names = new Map(projects.map((project) => [project.id, projectName(project)]));
  const projectOf = (thread: Thread) => (thread.projectId && names.get(thread.projectId)) ?? null;
  const term = query.trim().toLowerCase();
  const shown = term ? archivedThreads.filter((thread) => [thread.title, projectOf(thread) ?? ""].some((text) => text.toLowerCase().includes(term))) : archivedThreads;
  const count = archivedThreads.length === 1 ? "1 thread" : `${archivedThreads.length} threads`;
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Archived threads</h2>
        <p>Archived threads stay here for 5 days, then AI Coding Tool deletes them on the next launch.</p>
      </div>

      <section ref={rows.ref} onClickCapture={rows.onClickCapture} className="settings-group" aria-labelledby="archive-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="archive-heading">Archive</h3>
            <p>Restore a thread to put it back in the sidebar. Its automation stays off.</p>
            <p role="status" className="settings-status done">{restored && `Restored “${restored}” to the sidebar`}</p>
          </div>
          <div className="settings-group-action">
            <span>{archivedThreads.length} archived</span>
            {archivedThreads.length > 0 && <ConfirmAction className="danger" confirm={`Delete ${count}`} onConfirm={() => { setRestored(null); onClearArchive(); }}>Clear all</ConfirmAction>}
          </div>
        </div>

        {archivedThreads.length > 0 && (
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
                  <p>{[projectOf(thread), daysLeft(thread.archivedAt!)].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="setting-row-action">
                  <button type="button" aria-label={`Restore ${thread.title}`} onClick={() => { setRestored(thread.title); onRestoreThread(thread.id); }}>Restore</button>
                </div>
              </div>
            ))}
      </section>
    </main>
  );
}
