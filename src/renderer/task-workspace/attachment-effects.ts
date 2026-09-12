import { errorMessage } from "./errors";
import { markPrefix } from "../../application/attachments";
import { renderAnnotatedSource } from "../annotate/marks";
import type { OutgoingAttachment, RunAttachment } from "../../domain/conversation";
import type { DesktopAPI } from "../../contracts/ipc";
import type { EffectHandlers } from "./effect-host";

/** A staged image is already on disk; only the marks drawn on it since need writing back. */
async function written(attachment: OutgoingAttachment, at: number, total: number, desktop: DesktopAPI): Promise<RunAttachment> {
  const marked = attachment.annotations.length === 0
    ? attachment.source
    : await renderAnnotatedSource(attachment.source, attachment.annotations, markPrefix(at, total));
  const path = attachment.path !== undefined && attachment.annotations.length === 0
    ? attachment.path
    : await desktop.saveAttachment(marked.replace(/^data:[^,]*,/, ""), attachment.path);
  return {
    path,
    labels: attachment.annotations.filter((annotation) => annotation.kind === "box").map((annotation) => annotation.text),
    ...(attachment.context ? { context: attachment.context } : {}),
  };
}

/** The composer's images on their way out, which the message they ride waits for. */
export const attachmentEffects = {
  "send-attachments": async ({ taskId, steer, attachments }, { dispatch, desktop }) => {
    const composer = taskId === undefined ? {} : { taskId };
    try {
      const saved = await Promise.all(attachments.map((attachment, at) => written(attachment, at, attachments.length, desktop)));
      const ids = attachments.map((attachment) => attachment.id);
      await dispatch({ type: "attachments.saved", ...composer, ...(steer ? { steer } : {}), ids, attachments: saved });
    } catch (error) {
      await dispatch({ type: "attachments.failed", ...composer, message: errorMessage(error) });
    }
  },
} satisfies EffectHandlers<"send-attachments">;
