/** The images a composer sends: what has to be on disk first, and what stopped them getting there. */
import { reduceSending } from "./sending.js";
import { afterward, type SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import { attachmentSendFor, MAIN_COMPOSER, type AttachmentSendState } from "../composer-attachments.js";
import { imagesFor, withImages } from "../composer-drafts.js";
import { promptKey, type WorkspaceState } from "../workspace-state.js";
import type { ComposerState } from "../state/composer.js";
import { MAX_ATTACHMENTS, type RunAttachment } from "../../domain/conversation.js";
import type { OutgoingAttachment } from "../../domain/conversation.js";

const MOVED_DRAFT_ERROR = "The images were not sent because you left the new thread. Send them again from there.";

export const ATTACHMENT_INPUTS = ["attachments.send", "attachments.saved", "attachments.failed", "attachments.notice"] as const;
type AttachmentInput = Extract<WorkspaceInput, { type: (typeof ATTACHMENT_INPUTS)[number] }>;

export type AttachmentEvent =
  /** The composer's images, now on disk, and the ids of the ones the strip can let go of. */
  | { type: "attachments.saved"; taskId?: string; steer?: boolean; text?: string; ids: string[]; attachments: RunAttachment[] }
  | { type: "attachments.failed"; taskId?: string; message: string };

/** Writes a composer's images out, then sends the message they ride, in that order. */
export type AttachmentEffect = { type: "send-attachments"; taskId?: string; steer?: boolean; text?: string; attachments: OutgoingAttachment[] };

/** The images a composer sends are the composer's own. */
type Own = ComposerState;

function withSend(state: Own, taskId: string | undefined, send: AttachmentSendState): Pick<Own, "attachmentSends"> {
  return { attachmentSends: { ...state.attachmentSends, [taskId ?? MAIN_COMPOSER]: send } };
}

/** A marked image leaves as a new file, so its draft follows that file until the run that carries it starts. */
function withWrittenImages(state: WorkspaceState, { taskId, ids, attachments }: Extract<AttachmentInput, { type: "attachments.saved" }>): Pick<Own, "images"> {
  const key = taskId ?? attachmentSendFor(state.attachmentSends).draftKey ?? promptKey(state);
  return withImages({ images: state.images }, key, imagesFor(state, key).map((image) => {
    const at = ids.indexOf(image.id);
    return at < 0 ? image : { ...image, path: attachments[at]!.path };
  }));
}

/** The images' send. Words that came with them, from a phone, go with them; otherwise the composer's own are sent. */
function sent(state: WorkspaceState, input: AttachmentInput, attachments: RunAttachment[], steer?: boolean, text?: string): SliceTransition<Own> {
  return reduceSending(state, {
    type: "task.send",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    attachments,
    ...(steer ? { steer } : {}),
    ...(text ? { text } : {}),
  });
}

export function reduceComposerAttachments(state: WorkspaceState, input: AttachmentInput): SliceTransition<Own> {
  const send = attachmentSendFor(state.attachmentSends, input.taskId);
  switch (input.type) {
    case "attachments.send": {
      /** One send carries the whole strip, so a second cannot start until the first has written and started. */
      const key = input.taskId ?? promptKey(state);
      if (send.busy || Object.values(state.pendingRuns).some((pending) => pending.draftKey === key)) return {};
      /** Pasting and grabbing fill the same strip from different sides, so the total is checked once here. */
      if (input.attachments.length > MAX_ATTACHMENTS) {
        return { patch: withSend(state, input.taskId, { ...send, error: `You can attach up to ${MAX_ATTACHMENTS} images.` }), result: { ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} images.` } };
      }
      if (input.attachments.length === 0) return sent(state, input, [], input.steer, input.text);
      return {
        patch: withSend(state, input.taskId, { busy: true, error: null, sent: send.sent, ...(input.taskId === undefined && input.text === undefined ? { draftKey: key } : {}) }),
        effects: [{
          type: "send-attachments",
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.steer ? { steer: input.steer } : {}),
          ...(input.text ? { text: input.text } : {}),
          attachments: input.attachments,
        }],
      };
    }

    case "attachments.saved": {
      /** The main composer moved on while they were written, so they go to the thread they left from. */
      const left = send.draftKey !== undefined && send.draftKey !== promptKey(state) ? send.draftKey : undefined;
      if (left !== undefined && !state.threads.some((thread) => thread.id === left)) {
        return { patch: withSend(state, input.taskId, { busy: false, error: MOVED_DRAFT_ERROR, sent: [] }), result: { ok: false, message: MOVED_DRAFT_ERROR } };
      }
      const written = { ...withWrittenImages(state, input), ...withSend(state, input.taskId, { busy: false, error: null, sent: input.ids }) };
      return { patch: written, ...sent(afterward(state, { patch: written }), left === undefined ? input : { ...input, taskId: left }, input.attachments, input.steer, input.text) };
    }

    case "attachments.failed":
      return { patch: withSend(state, input.taskId, { busy: false, error: input.message, sent: send.sent }), result: { ok: false, message: input.message } };

    case "attachments.notice":
      if (send.error === input.message) return {};
      return { patch: withSend(state, input.taskId, { ...send, error: input.message }) };
  }
}
