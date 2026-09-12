/** Where one composer's images stand between the send and the run that carries them. */
export type AttachmentSendState = {
  /** Set while the images are being written out, so a second send cannot start on top of the first. */
  busy: boolean;
  error: string | null;
  /** The images this composer last sent, so the strip drops the ones that are on disk and gone. */
  sent: string[];
};

export const NO_ATTACHMENT_SEND: AttachmentSendState = { busy: false, error: null, sent: [] };

/** The main composer sends for whichever thread is in front, so it has no thread of its own to key by. */
export const MAIN_COMPOSER = "";

export function attachmentSendFor(sends: Record<string, AttachmentSendState>, taskId?: string): AttachmentSendState {
  return sends[taskId ?? MAIN_COMPOSER] ?? NO_ATTACHMENT_SEND;
}
