import { LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { markPrefix } from "../../application/attachments";
import type { AttachmentSendState } from "../../application/composer-attachments";
import { MAX_ATTACHMENTS, type OutgoingAttachment, type StagedImage } from "../../domain/conversation";
import type { ScreenshotContext } from "../../domain/screenshot-context";
import { ImageAnnotator, type Annotation } from "./ImageAnnotator";

type Attachment = {
  id: string;
  source: string;
  preview: string;
  annotations: Annotation[];
  /** Where the image already sits on disk, for one the workspace staged rather than the composer read. */
  path?: string;
  context?: ScreenshotContext;
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

/** The one way a composer's message leaves, and where the images riding it stand. */
export type ComposerOutbox = {
  state: AttachmentSendState;
  send: (attachments: OutgoingAttachment[], steer: boolean) => void;
  /** What the strip itself has to say, which shares the one line the send's own failures use. */
  notice: (message: string | null) => void;
};

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
  send: (steer: boolean) => void;
};

/** The images riding the next send, whether they were pasted in or staged by the workspace. */
export function useComposerAttachments(images: StagedImage[], outbox: ComposerOutbox, onImageRemove?: (imageId: string) => void): ComposerAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const outgoing = useRef(outbox);
  outgoing.current = outbox;
  /** Which staged images have already been read in, so a rerender never reads the same one twice. */
  const takenImages = useRef(new Set<string>());

  async function attachPasted(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      outbox.notice(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    try {
      const added = await Promise.all(files.slice(0, room).map(readImage));
      setAttachments((current) => [...current, ...added]);
      outbox.notice(files.length > room ? `Only the first ${room} image${room === 1 ? "" : "s"} were attached.` : null);
    } catch (error) {
      outbox.notice(error instanceof Error ? error.message : String(error));
    }
  }

  function send(steer: boolean) {
    if (loading || images.some((image) => takenImages.current.has(image.id) && !attachments.some((attachment) => attachment.id === image.id))) {
      outbox.notice("Wait for the screenshots to finish loading.");
      return;
    }
    outbox.send(attachments.map((attachment) => ({
      id: attachment.id,
      source: attachment.source,
      annotations: attachment.annotations,
      ...(attachment.path === undefined ? {} : { path: attachment.path }),
      ...(attachment.context ? { context: attachment.context } : {}),
    })), steer);
  }

  /** The images that are on disk and away belong to the message that carried them, not to the strip. */
  const sent = outbox.state.sent;
  useEffect(() => {
    if (sent.length === 0) return;
    setAttachments((current) => {
      const kept = current.filter((attachment) => !sent.includes(attachment.id));
      return kept.length === current.length ? current : kept;
    });
  }, [sent]);

  /**
   * The workspace holds staged images as paths; the composer needs their bytes to draw on them, so
   * each one is read in once and then behaves exactly like an image pasted in.
   */
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const staged = new Set(images.map((image) => image.id));
    for (const id of takenImages.current) if (!staged.has(id)) takenImages.current.delete(id);
    setAttachments((current) => {
      const kept = current.filter((item) => item.path === undefined || staged.has(item.id));
      return kept.length === current.length ? current : kept;
    });
    const arriving = images.filter((image) => !takenImages.current.has(image.id));
    if (arriving.length === 0) { setLoading(false); return; }
    setLoading(true);
    for (const image of arriving) takenImages.current.add(image.id);
    void (async () => {
      try {
        const read = await Promise.all(arriving.map(async (image) => {
          const [preview, context] = await Promise.all([
            dataUrlOf(image.path),
            window.desktop.readAttachmentContext(image.path).catch(() => null),
          ]);
          return { image, preview, context };
        }));
        if (cancelled) return;
        setAttachments((current) => [
          ...current,
          ...read
            .filter(({ image }) => !current.some((item) => item.id === image.id))
            .map(({ image, preview, context }) => ({ id: image.id, source: preview, preview, annotations: [], path: image.path, ...(context ? { context } : {}) })),
        ]);
        outgoing.current.notice(null);
      } catch (error) {
        if (cancelled) return;
        for (const image of arriving) takenImages.current.delete(image.id);
        outgoing.current.notice(error instanceof Error ? error.message : String(error));
      } finally {
        settled = true;
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (!settled) for (const image of arriving) takenImages.current.delete(image.id);
    };
  }, [images]);

  return {
    items: attachments,
    error: outbox.state.error,
    sending: outbox.state.busy || loading,
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
