/** The images a composer sends: what has to be on disk first, and what stopped them getting there. */
import { reduceSending } from "./sending.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { attachmentSendFor, MAIN_COMPOSER, type AttachmentSendState } from "../composer-attachments.js";
import { imagesFor, withImages } from "../composer-drafts.js";
import { promptKey, type WorkspaceState } from "../workspace-state.js";
import { MAX_ATTACHMENTS, type RunAttachment } from "../../domain/conversation.js";

const MOVED_DRAFT_ERROR = "The images were not sent because you left the new thread. Send them again from there.";

export const ATTACHMENT_INPUTS = ["attachments.send", "attachments.saved", "attachments.failed", "attachments.notice"] as const;
type AttachmentInput = Extract<WorkspaceInput, { type: (typeof ATTACHMENT_INPUTS)[number] }>;

function withSend(state: WorkspaceState, taskId: string | undefined, send: AttachmentSendState): WorkspaceState {
  return { ...state, attachmentSends: { ...state.attachmentSends, [taskId ?? MAIN_COMPOSER]: send } };
}

/** A marked image leaves as a new file, so its draft follows that file until the run that carries it starts. */
function withWrittenImages(state: WorkspaceState, { taskId, ids, attachments }: Extract<AttachmentInput, { type: "attachments.saved" }>): WorkspaceState {
  const key = taskId ?? attachmentSendFor(state.attachmentSends).draftKey ?? promptKey(state);
  return withImages(state, key, imagesFor(state, key).map((image) => {
    const at = ids.indexOf(image.id);
    return at < 0 ? image : { ...image, path: attachments[at]!.path };
  }));
}

/** The images' send. Words that came with them, from a phone, go with them; otherwise the composer's own are sent. */
function sent(state: WorkspaceState, input: AttachmentInput, attachments: RunAttachment[], steer?: boolean, text?: string): WorkspaceTransition {
  return reduceSending(state, {
    type: "task.send",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    attachments,
    ...(steer ? { steer } : {}),
    ...(text ? { text } : {}),
  });
}

export function reduceComposerAttachments(state: WorkspaceState, input: AttachmentInput): WorkspaceTransition {
  const send = attachmentSendFor(state.attachmentSends, input.taskId);
  switch (input.type) {
    case "attachments.send": {
      /** One send carries the whole strip, so a second cannot start until the first has written and started. */
      const key = input.taskId ?? promptKey(state);
      if (send.busy || Object.values(state.pendingRuns).some((pending) => pending.draftKey === key)) return settled(state);
      /** Pasting and grabbing fill the same strip from different sides, so the total is checked once here. */
      if (input.attachments.length > MAX_ATTACHMENTS) {
        return settled(withSend(state, input.taskId, { ...send, error: `You can attach up to ${MAX_ATTACHMENTS} images.` }), [], { ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} images.` });
      }
      if (input.attachments.length === 0) return sent(state, input, [], input.steer, input.text);
      return settled(
        withSend(state, input.taskId, { busy: true, error: null, sent: send.sent, ...(input.taskId === undefined && input.text === undefined ? { draftKey: key } : {}) }),
        [{
          type: "send-attachments",
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.steer ? { steer: input.steer } : {}),
          ...(input.text ? { text: input.text } : {}),
          attachments: input.attachments,
        }],
      );
    }

    case "attachments.saved": {
      /** The main composer moved on while they were written, so they go to the thread they left from. */
      const left = send.draftKey !== undefined && send.draftKey !== promptKey(state) ? send.draftKey : undefined;
      if (left !== undefined && !state.threads.some((thread) => thread.id === left)) {
        return settled(withSend(state, input.taskId, { busy: false, error: MOVED_DRAFT_ERROR, sent: [] }), [], { ok: false, message: MOVED_DRAFT_ERROR });
      }
      const written = withSend(withWrittenImages(state, input), input.taskId, { busy: false, error: null, sent: input.ids });
      return sent(written, left === undefined ? input : { ...input, taskId: left }, input.attachments, input.steer, input.text);
    }

    case "attachments.failed":
      return settled(withSend(state, input.taskId, { busy: false, error: input.message, sent: send.sent }), [], { ok: false, message: input.message });

    case "attachments.notice":
      if (send.error === input.message) return settled(state);
      return settled(withSend(state, input.taskId, { ...send, error: input.message }));
  }
}
