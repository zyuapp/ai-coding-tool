import { LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuDownload as Download } from "react-icons/lu";
import { useCallback, useState, type CSSProperties } from "react";
import { IconButton } from "../ui/Button";
import { Viewer } from "../ui/Dialog";
import "../ui/glass.css";
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
  const index = gallery.length > 1 ? gallery.indexOf(source) : -1;
  const stepping = index >= 0;
  const step = useCallback((event: KeyboardEvent) => {
    if (!stepping || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    onStep(delta);
  }, [onStep, stepping]);

  return (
    <Viewer label="Screenshot" className={stepping ? "image gallery" : "image"} onClose={onClose} onKeyDown={step}>
      <ViewedImage key={source} source={source} onDownload={onDownload} />
      {stepping && <>
        <IconButton className="viewer-step previous" variant="soft" size="md" round label="Previous image" tip={shortcutTip("Previous", "ArrowLeft")} aria-keyshortcuts="ArrowLeft" disabled={index === 0} onClick={(event) => { event.stopPropagation(); onStep(-1); }}><ChevronLeft size={20} aria-hidden="true" /></IconButton>
        <IconButton className="viewer-step next" variant="soft" size="md" round label="Next image" tip={shortcutTip("Next", "ArrowRight")} aria-keyshortcuts="ArrowRight" disabled={index === gallery.length - 1} onClick={(event) => { event.stopPropagation(); onStep(1); }}><ChevronRight size={20} aria-hidden="true" /></IconButton>
        <div className="viewer-count glass-float" aria-live="polite">{index + 1} / {gallery.length}</div>
      </>}
    </Viewer>
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
      <IconButton className="viewer-download" variant="soft" size="md" label="Download image" tip="Download" onClick={(event) => { event.stopPropagation(); onDownload(); }}><Download size={16} /></IconButton>
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
