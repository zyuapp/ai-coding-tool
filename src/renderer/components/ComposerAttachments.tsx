import { LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { markPrefix } from "../../application/attachments";
import { MAX_ATTACHMENTS, type RunAttachment, type StagedImage } from "../../domain/task";
import { ImageAnnotator, renderAnnotatedSource, type Annotation } from "./ImageAnnotator";

type Attachment = {
  id: string;
  source: string;
  preview: string;
  annotations: Annotation[];
  /** Where the image already sits on disk, for one the workspace staged rather than the composer read. */
  path?: string;
};

/** Reads a file this app already wrote into the attachments directory back out as a data URL. */
async function dataUrlOf(path: string) {
  return `data:image/png;base64,${await window.desktop.readAttachment(path)}`;
}

function readImage(file: File) {
  return new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const source = String(reader.result);
      resolve({ id: crypto.randomUUID(), source, preview: source, annotations: [] });
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the pasted image.")));
    reader.readAsDataURL(file);
  });
}

export type ComposerAttachments = {
  items: Attachment[];
  error: string | null;
  /** Set while the images are being written out, so a second send cannot start on top of the first. */
  sending: boolean;
  editing: Attachment | undefined;
  attachPasted: (files: File[]) => Promise<void>;
  annotate: (attachmentId: string) => void;
  closeEditor: () => void;
  applyAnnotations: (attachmentId: string, annotations: Annotation[], rendered: string) => void;
  remove: (attachment: Attachment) => void;
  send: (onSend: (attachments: RunAttachment[], steer: boolean) => void, steer: boolean) => Promise<void>;
};

/** The images riding the next send, whether they were pasted in or staged by the workspace. */
export function useComposerAttachments(images: StagedImage[], onImageRemove?: (imageId: string) => void): ComposerAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Which staged images have already been read in, so a rerender never reads the same one twice. */
  const takenImages = useRef(new Set<string>());

  async function attachPasted(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    try {
      const added = await Promise.all(files.slice(0, room).map(readImage));
      setAttachments((current) => [...current, ...added]);
      setAttachmentError(files.length > room ? `Only the first ${room} image${room === 1 ? "" : "s"} were attached.` : null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function send(onSend: (attachments: RunAttachment[], steer: boolean) => void, steer: boolean) {
    if (attachments.length === 0) {
      onSend([], steer);
      return;
    }
    /** Pasting and grabbing fill the same row from different sides, so the total is checked once here. */
    if (attachments.length > MAX_ATTACHMENTS) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    setSending(true);
    try {
      const saved = await Promise.all(attachments.map(async (attachment, at) => ({
        /** A staged image is already on disk; only its annotations, drawn since, need writing back. */
        path: attachment.path !== undefined && attachment.annotations.length === 0
          ? attachment.path
          : await window.desktop.saveAttachment(
            (attachment.annotations.length === 0
              ? attachment.source
              : await renderAnnotatedSource(attachment.source, attachment.annotations, markPrefix(at, attachments.length))
            ).replace(/^data:[^,]*,/, ""),
          ),
        labels: attachment.annotations.filter((annotation) => annotation.kind === "box").map((annotation) => annotation.text),
      })));
      setAttachments([]);
      setAttachmentError(null);
      onSend(saved, steer);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  /**
   * The workspace holds staged images as paths; the composer needs their bytes to draw on them, so
   * each one is read in once and then behaves exactly like an image pasted in.
   */
  useEffect(() => {
    let cancelled = false;
    const staged = new Set(images.map((image) => image.id));
    for (const id of takenImages.current) if (!staged.has(id)) takenImages.current.delete(id);
    setAttachments((current) => {
      const kept = current.filter((item) => item.path === undefined || staged.has(item.id));
      return kept.length === current.length ? current : kept;
    });
    const arriving = images.filter((image) => !takenImages.current.has(image.id));
    if (arriving.length === 0) return;
    for (const image of arriving) takenImages.current.add(image.id);
    void (async () => {
      try {
        const read = await Promise.all(arriving.map(async (image) => ({ image, preview: await dataUrlOf(image.path) })));
        if (cancelled) return;
        setAttachments((current) => [
          ...current,
          ...read
            .filter(({ image }) => !current.some((item) => item.id === image.id))
            .map(({ image, preview }) => ({ id: image.id, source: preview, preview, annotations: [], path: image.path })),
        ]);
      } catch (error) {
        if (cancelled) return;
        for (const image of arriving) takenImages.current.delete(image.id);
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [images]);

  return {
    items: attachments,
    error: attachmentError,
    sending,
    editing: attachments.find((attachment) => attachment.id === annotating),
    attachPasted,
    annotate: setAnnotating,
    closeEditor: () => setAnnotating(null),
    applyAnnotations: (attachmentId, annotations, rendered) => {
      setAttachments((current) => current.map((item) => item.id === attachmentId ? { ...item, annotations, preview: rendered } : item));
      setAnnotating(null);
    },
    remove: (attachment) => (attachment.path !== undefined
      ? onImageRemove?.(attachment.id)
      : setAttachments((current) => current.filter((item) => item.id !== attachment.id))),
    send,
  };
}

export function AttachmentStrip({ attachments }: { attachments: ComposerAttachments }) {
  if (attachments.items.length === 0) return null;

  return (
    <div className="attachment-row">
      {attachments.items.map((attachment, index) => (
        <div className="attachment-chip" key={attachment.id}>
          <button type="button" className="attachment-open" onClick={() => attachments.annotate(attachment.id)} aria-label={`Annotate image ${index + 1}`}>
            <img src={attachment.preview} alt="" />
            {attachment.annotations.length > 0 && <span className="attachment-badge">{attachment.annotations.length}</span>}
          </button>
          <button
            type="button"
            className="attachment-remove"
            aria-label={`Remove image ${index + 1}`}
            onClick={() => attachments.remove(attachment)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AttachmentAnnotator({ attachments }: { attachments: ComposerAttachments }) {
  const editing = attachments.editing;
  if (!editing) return null;

  return (
    <ImageAnnotator
      source={editing.source}
      annotations={editing.annotations}
      prefix={markPrefix(attachments.items.indexOf(editing), attachments.items.length)}
      onCancel={attachments.closeEditor}
      onApply={(annotations, rendered) => attachments.applyAnnotations(editing.id, annotations, rendered)}
    />
  );
}
