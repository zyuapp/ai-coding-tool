import { LuCheck as Check, LuClipboardPaste as ClipboardPaste, LuCopy as Copy } from "react-icons/lu";
import { useEffect, useState } from "react";
import { pasteSummary } from "../../application/pastes";
import type { PastedText } from "../../domain/conversation";
import { copyText } from "../clipboard";
import { IconButton } from "../ui/Button";
import { Viewer } from "../ui/Dialog";
import "../ui/glass.css";
import { AttachedPill, AttachedRow } from "./AttachedPill";

/** How long the tick stands in for the copy icon after a copy. */
const COPIED_MS = 1400;

function PasteViewer({ paste, label, onClose }: { paste: PastedText; label: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (
    <IconButton
      className={`viewer-copy${copied ? " copied" : ""}`}
      variant="soft"
      size="md"
      label={copied ? "Copied" : "Copy pasted text"}
      tip="Copy"
      onClick={(event) => { event.stopPropagation(); void copyText(paste.text).then((done) => { if (done) setCopied(true); }); }}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </IconButton>
  );
  return (
    <Viewer label={label} className="paste" controls={copy} onClose={onClose}>
      <pre className="glass-float paste-full" onClick={(event) => event.stopPropagation()}>{paste.text}</pre>
    </Viewer>
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
    <AttachedRow className="paste-row" label="Pasted text">
      {pastes.map((paste, index) => (
        <AttachedPill
          key={paste.id}
          className="paste-pill"
          removeLabel={`Remove pasted text ${index + 1}`}
          removeClassName="paste-remove"
          onRemove={onRemove && (() => onRemove(paste.id))}
        >
          <button type="button" className="attached-pill-face paste-open" onClick={() => setReading(paste.id)} aria-label={`Read pasted text ${index + 1}`} data-tip="View">
            <ClipboardPaste size={12} aria-hidden="true" />
            <strong>Pasted text #{index + 1}</strong>
            <small>{pasteSummary(paste.text)}</small>
          </button>
        </AttachedPill>
      ))}
      {open && <PasteViewer paste={open} label={`Pasted text #${pastes.indexOf(open) + 1}`} onClose={() => setReading(null)} />}
    </AttachedRow>
  );
}
