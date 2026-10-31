import { LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuDownload as Download, LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";
import { ZoomControls, useZoom, type Sized } from "./ZoomView";
import { shortcutTip } from "./TooltipLayer";

type AttachmentViewerProps = {
  source: string;
  /** The pictures shown beside this one, in order. Fewer than two means there is nothing to step to. */
  gallery: string[];
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  onDownload: () => void;
};

export function AttachmentViewer({ source, gallery, onStep, onClose, onDownload }: AttachmentViewerProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const pressedOn = useRef<EventTarget | null>(null);
  const index = gallery.length > 1 ? gallery.indexOf(source) : -1;
  const stepping = index >= 0;
  useModalFocus(dialog);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!stepping || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!delta) return;
      event.preventDefault();
      onStep(delta);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, onStep, stepping]);

  return createPortal(
    <div
      ref={dialog}
      className={stepping ? "viewer image gallery" : "viewer image"}
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot"
      tabIndex={-1}
      onPointerDown={(event) => { pressedOn.current = event.target; }}
      /** Only a press and release on the same backdrop dismisses, so a drag off the picture does not. */
      onClick={(event) => { if (event.target === pressedOn.current) onClose(); }}
    >
      <ViewedImage key={source} source={source} onDownload={onDownload} />
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close screenshot" data-tip={shortcutTip("Close", "Escape")}><X size={16} /></button>
      {stepping && <>
        <button type="button" className="viewer-step previous" aria-label="Previous image" aria-keyshortcuts="ArrowLeft" data-tip={shortcutTip("Previous", "ArrowLeft")} disabled={index === 0} onClick={(event) => { event.stopPropagation(); onStep(-1); }}><ChevronLeft size={20} aria-hidden="true" /></button>
        <button type="button" className="viewer-step next" aria-label="Next image" aria-keyshortcuts="ArrowRight" data-tip={shortcutTip("Next", "ArrowRight")} disabled={index === gallery.length - 1} onClick={(event) => { event.stopPropagation(); onStep(1); }}><ChevronRight size={20} aria-hidden="true" /></button>
        <div className="viewer-count" aria-live="polite">{index + 1} / {gallery.length}</div>
      </>}
    </div>,
    document.body,
  );
}

/** One picture and its zoom, started afresh for each picture stepped to. */
function ViewedImage({ source, onDownload }: { source: string; onDownload: () => void }) {
  /** A picture reports its own size only once it has loaded, and nothing is fitted before then. */
  const [size, setSize] = useState<Sized | null>(null);
  const [failed, setFailed] = useState(false);
  const zoom = useZoom(size);
  const drawn: CSSProperties | undefined = size
    ? { width: `${size.width * zoom.scale}px`, height: `${size.height * zoom.scale}px`, maxWidth: "none", maxHeight: "none" }
    : undefined;
  return <>
    {size && !failed ? <>
      <ZoomControls zoom={zoom} />
      <button type="button" className="viewer-download" onClick={(event) => { event.stopPropagation(); onDownload(); }} aria-label="Download image" data-tip="Download"><Download size={16} /></button>
    </> : null}
    <div ref={zoom.stage} className="viewer-stage">
      {failed ? <p role="status">This image is no longer available.</p> : <img
        src={source}
        alt="Attached screenshot"
        style={drawn}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
        onClick={(event) => event.stopPropagation()}
      />}
    </div>
  </>;
}
