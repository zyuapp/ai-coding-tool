import type { RefObject } from "react";
import { ArrowUp, Check, MessageSquarePlus, Trash2, X } from "lucide-react";

export function DiffCommentEditor({ quote, note, editing, noteRef, onNote, onSubmit, onClear, onRemove }: {
  quote: string | null;
  note: string;
  editing: boolean;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  onNote: (note: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onRemove: () => void;
}) {
  return (
    <form
      className="diff-comment"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClear();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        onSubmit();
      }}
    >
      <header>
        <MessageSquarePlus size={13} aria-hidden="true" />
        <span className="diff-comment-range">{quote?.split("\n")[0]}</span>
        {editing && <button type="button" aria-label="Remove comment" onClick={onRemove}><Trash2 size={13} /></button>}
        <button type="button" aria-label="Clear the selection" onClick={onClear}><X size={14} /></button>
      </header>
      <textarea
        ref={noteRef}
        rows={1}
        aria-label="Note on the selected lines"
        placeholder="What should change here?"
        value={note}
        onInput={(event) => onNote(event.currentTarget.value)}
      />
      <footer>
        <span className="diff-comment-hint">Enter to {editing ? "save" : "add"}, Shift + Enter for a new line</span>
        <button className="send-button" type="submit" aria-label={editing ? "Save comment" : "Comment on the selected lines"} disabled={!note.trim()}>
          {editing ? <Check size={16} /> : <ArrowUp size={17} />}
        </button>
      </footer>
    </form>
  );
}
