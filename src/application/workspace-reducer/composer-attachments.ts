/** The images a composer sends: what has to be on disk first, and what stopped them getting there. */
import { reduceSending } from "./sending.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { attachmentSendFor, MAIN_COMPOSER, type AttachmentSendState } from "../composer-attachments.js";
import type { WorkspaceState } from "../workspace-state.js";
import { MAX_ATTACHMENTS, type RunAttachment } from "../../domain/conversation.js";

type AttachmentInput = Extract<WorkspaceInput, {
  type: "attachments.send" | "attachments.saved" | "attachments.failed" | "attachments.notice";
}>;

function withSend(state: WorkspaceState, taskId: string | undefined, send: AttachmentSendState): WorkspaceState {
  return { ...state, attachmentSends: { ...state.attachmentSends, [taskId ?? MAIN_COMPOSER]: send } };
}

function sent(state: WorkspaceState, input: AttachmentInput, attachments: RunAttachment[], steer?: boolean): WorkspaceTransition {
  return reduceSending(state, {
    type: "task.send",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    attachments,
    ...(steer ? { steer } : {}),
  });
}

export function reduceComposerAttachments(state: WorkspaceState, input: AttachmentInput): WorkspaceTransition {
  const send = attachmentSendFor(state.attachmentSends, input.taskId);
  switch (input.type) {
    case "attachments.send": {
      /** One send writes the whole strip out, so a second cannot start while the first is writing. */
      if (send.busy) return settled(state);
      /** Pasting and grabbing fill the same strip from different sides, so the total is checked once here. */
      if (input.attachments.length > MAX_ATTACHMENTS) {
        return settled(withSend(state, input.taskId, { ...send, error: `You can attach up to ${MAX_ATTACHMENTS} images.` }));
      }
      if (input.attachments.length === 0) return sent(state, input, [], input.steer);
      return settled(
        withSend(state, input.taskId, { ...send, busy: true, error: null }),
        [{
          type: "send-attachments",
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.steer ? { steer: input.steer } : {}),
          attachments: input.attachments,
        }],
      );
    }

    case "attachments.saved":
      return sent(withSend(state, input.taskId, { busy: false, error: null, sent: input.ids }), input, input.attachments, input.steer);

    case "attachments.failed":
      return settled(withSend(state, input.taskId, { ...send, busy: false, error: input.message }));

    case "attachments.notice":
      if (send.error === input.message) return settled(state);
      return settled(withSend(state, input.taskId, { ...send, error: input.message }));
  }
}
