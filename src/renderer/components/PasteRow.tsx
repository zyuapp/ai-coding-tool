import { LuClipboardPaste as ClipboardPaste, LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pasteSummary } from "../../application/pastes";
import type { PastedText } from "../../domain/conversation";
import { useModalFocus } from "../focus";

function PasteViewer({ paste, label, onClose }: { paste: PastedText; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div ref={dialog} className="viewer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onClick={onClose}>
      <button type="button" className="viewer-close" onClick={onClose} aria-label={`Close ${label.toLowerCase()}`}><X size={16} /></button>
      <pre className="paste-full" onClick={(event) => event.stopPropagation()}>{paste.text}</pre>
    </div>,
    document.body,
  );
}

/** Pasted blocks as pills: removable while drafted in a composer, read-only on a sent message. */
export function PasteRow({ pastes, onRemove }: {
  pastes: PastedText[];
  onRemove?: (pasteId: string) => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const open = pastes.find((paste) => paste.id === reading);
  if (pastes.length === 0) return null;

  return (
    <div className="paste-row" role="list" aria-label="Pasted text">
      {pastes.map((paste, index) => (
        <span className="paste-pill" role="listitem" key={paste.id}>
          <button type="button" className="paste-open" onClick={() => setReading(paste.id)} aria-label={`Read pasted text ${index + 1}`}>
            <ClipboardPaste size={12} aria-hidden="true" />
            <strong>Pasted text #{index + 1}</strong>
            <small>{pasteSummary(paste.text)}</small>
          </button>
          {onRemove && (
            <button type="button" className="paste-remove" aria-label={`Remove pasted text ${index + 1}`} onClick={() => onRemove(paste.id)}>
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {open && <PasteViewer paste={open} label={`Pasted text #${pastes.indexOf(open) + 1}`} onClose={() => setReading(null)} />}
    </div>
  );
}
