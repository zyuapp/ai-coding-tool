import { X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";
import { ZoomControls, useZoom, type Sized } from "./ZoomView";

export function AttachmentViewer({ source, onClose }: { source: string; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const pressedOn = useRef<EventTarget | null>(null);
  /** A picture reports its own size only once it has loaded, and nothing is fitted before then. */
  const [size, setSize] = useState<Sized | null>(null);
  const zoom = useZoom(size);
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

  const drawn: CSSProperties | undefined = size
    ? { width: `${size.width * zoom.scale}px`, height: `${size.height * zoom.scale}px`, maxWidth: "none", maxHeight: "none" }
    : undefined;
  return createPortal(
    <div
      ref={dialog}
      className="viewer image"
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot"
      tabIndex={-1}
      onPointerDown={(event) => { pressedOn.current = event.target; }}
      /** Only a press and release on the same backdrop dismisses, so a drag off the picture does not. */
      onClick={(event) => { if (event.target === pressedOn.current) onClose(); }}
    >
      {size ? <ZoomControls zoom={zoom} /> : null}
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close screenshot"><X size={16} /></button>
      <div ref={zoom.stage} className="viewer-stage">
        <img
          src={source}
          alt="Attached screenshot"
          style={drawn}
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  );
}
