import { useState } from "react";
import { MAX_TITLE_LENGTH } from "../../contracts/mobile";
import { Sheet } from "./Sheet";

export function RenameSheet({ title, onClose, onRename }: { title: string; onClose: () => void; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  const changed = draft.trim() !== title;
  function save() {
    onRename(draft.trim());
    onClose();
  }
  return (
    <Sheet title="Rename" onClose={onClose} action={<button type="button" className="sheet-done" disabled={!changed} onClick={save}>Save</button>}>
      <form className="rename-form" onSubmit={(event) => { event.preventDefault(); if (changed) save(); }}>
        <input
          type="text"
          aria-label="Thread title"
          value={draft}
          maxLength={MAX_TITLE_LENGTH}
          enterKeyHint="done"
          autoCapitalize="sentences"
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <p className="sheet-note">An empty name lets the next reply name the thread.</p>
      </form>
    </Sheet>
  );
}
