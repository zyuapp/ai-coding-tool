import { LuArchive as Archive } from "react-icons/lu";
import { archiveConsequence, archiveQuestion } from "../../domain/thread-retention";
import { Sheet } from "./Sheet";

/** The question asked before the user archives a thread, as the desktop asks it. */
export function ArchiveSheet({ title, running, onClose, onArchive }: { title: string; running: boolean; onClose: () => void; onArchive: () => void }) {
  return (
    <Sheet title={archiveQuestion(title)} label="Archive thread" onClose={onClose} action={<button type="button" className="sheet-done sheet-cancel" onClick={onClose}>Cancel</button>}>
      <p className="sheet-note sheet-lead">{archiveConsequence(running, true)}</p>
      <div className="menu-group">
        <button type="button" className="menu-row" data-danger onClick={() => { onClose(); onArchive(); }}>
          <span className="menu-glyph" aria-hidden="true"><Archive size={18} strokeWidth={1.8} /></span>
          <span className="menu-copy"><strong>Archive</strong></span>
        </button>
      </div>
    </Sheet>
  );
}
