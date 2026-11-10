import { useRef, useState } from "react";
import { ARCHIVE_RETENTION_MS } from "../../domain/thread-retention";
import type { Thread } from "../../domain/thread";
import { SettingRowBase, useRowListFocus } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { SearchField } from "../ui/Field";
import { ConfirmAction } from "../ui/ConfirmAction";

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
  const rows = useRowListFocus<HTMLElement>();
  const filtering = archivedThreads.length > ARCHIVE_FILTER_FROM;
  const term = filtering ? query.trim().toLowerCase() : "";
  const shown = term ? archivedThreads.filter((thread) => thread.title.toLowerCase().includes(term)) : archivedThreads;
  const count = archivedThreads.length === 1 ? "1 thread" : `${archivedThreads.length} threads`;
  return (
    <SettingsPage title="Archived threads" description="Archived threads stay here for 5 days, then AI Coding Tool deletes them on the next launch.">
      <SettingsSection ref={rows.ref} onClickCapture={rows.onClickCapture} title="Archive" description="Restore a thread to put it back in the sidebar. Its automation stays off." action={<>
        <span>{archivedThreads.length} archived</span>
        {archivedThreads.length > 0 && <ConfirmAction variant="danger" confirm={`Delete ${count}`} onConfirm={onClearArchive}>Clear all</ConfirmAction>}
      </>}>
        {filtering && (
          <SearchField
            ref={field}
            wrapClassName="settings-filter"
            label="Filter archived threads"
            value={query}
            spellCheck={false}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
          />
        )}

        {archivedThreads.length === 0
          ? <p className="settings-empty">Nothing archived.</p>
          : shown.length === 0
            ? <p className="settings-empty">No archived thread matches “{query.trim()}”. <Button variant="link" className="settings-empty-action" onClick={() => { setQuery(""); field.current?.focus(); }}>Clear filter</Button></p>
            : shown.map((thread) => (
              <SettingRowBase key={thread.id} title={thread.title} description={daysLeft(thread.archivedAt!)}>
                <Button aria-label={`Restore ${thread.title}`} onClick={() => onRestoreThread(thread.id)}>Restore</Button>
              </SettingRowBase>
            ))}
      </SettingsSection>
    </SettingsPage>
  );
}
