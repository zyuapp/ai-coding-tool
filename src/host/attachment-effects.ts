import { errorMessage } from "./errors.js";
import type { OutgoingAttachment, RunAttachment } from "../domain/conversation.js";
import type { RuntimeDesktop } from "./runtime-desktop.js";
import type { EffectHandlers } from "./effect-host.js";

/**
 * A staged image that carries no marks is already on disk. One that does arrives with the marks
 * already drawn into its source by the composer that drew them, so only the file needs writing.
 */
async function written(attachment: OutgoingAttachment, desktop: RuntimeDesktop): Promise<RunAttachment> {
  const path = attachment.path !== undefined && attachment.annotations.length === 0
    ? attachment.path
    : await desktop.saveAttachment(attachment.source.replace(/^data:[^,]*,/, ""), attachment.path);
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
      const saved = await Promise.all(attachments.map((attachment) => written(attachment, desktop)));
      const ids = attachments.map((attachment) => attachment.id);
      await dispatch({ type: "attachments.saved", ...composer, ...(steer ? { steer } : {}), ids, attachments: saved });
    } catch (error) {
      await dispatch({ type: "attachments.failed", ...composer, message: errorMessage(error) });
    }
  },
} satisfies EffectHandlers<"send-attachments">;
