import { LuX as X } from "react-icons/lu";
import { useRef, useState } from "react";
import { MAX_TITLE_LENGTH } from "../../contracts/mobile";
import { Sheet } from "./Sheet";

export function RenameSheet({ title, onClose, onRename }: { title: string; onClose: () => void; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  const field = useRef<HTMLInputElement>(null);
  const changed = draft.trim() !== title;
  function save() {
    onRename(draft.trim());
    onClose();
  }
  return (
    <Sheet title="Rename" onClose={onClose} action={
      <span className="sheet-actions-head">
        <button type="button" className="sheet-done sheet-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="sheet-done" disabled={!changed} onClick={save}>Save</button>
      </span>
    }>
      <form className="rename-form" onSubmit={(event) => { event.preventDefault(); if (changed) save(); }}>
        <span className="rename-field">
          <input
            ref={field}
            type="text"
            aria-label="Thread title"
            value={draft}
            maxLength={MAX_TITLE_LENGTH}
            enterKeyHint="done"
            autoCapitalize="sentences"
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          {draft && <button type="button" className="field-clear" aria-label="Clear title" onClick={() => { setDraft(""); field.current?.focus(); }}><X size={16} strokeWidth={2.2} aria-hidden="true" /></button>}
        </span>
        <p className="sheet-note">An empty name lets the next reply name the thread.</p>
      </form>
    </Sheet>
  );
}
