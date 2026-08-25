import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";

export function AttachmentViewer({ source, onClose }: { source: string; onClose: () => void }) {
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
    <div ref={dialog} className="viewer" role="dialog" aria-modal="true" aria-label="Screenshot" tabIndex={-1} onClick={onClose}>
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close screenshot"><X size={16} /></button>
      <img src={source} alt="Attached screenshot" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}
