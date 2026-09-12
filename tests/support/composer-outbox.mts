import { useState } from "react";
import { NO_ATTACHMENT_SEND } from "../../src/application/composer-attachments.ts";
import type { ComposerOutbox } from "../../src/renderer/components/ComposerAttachments.tsx";
import { attachmentEffects } from "../../src/host/attachment-effects.ts";
import type { RunAttachment } from "../../src/domain/conversation.ts";

/** A composer whose sends go nowhere, for surfaces under test that only have to reach one. */
export function outbox(overrides: Partial<ComposerOutbox> = {}): ComposerOutbox {
  return { state: NO_ATTACHMENT_SEND, send() {}, notice() {}, ...overrides };
}

/**
 * A composer wired to the effect that writes its images out, and to the little of the reducer's
 * answer the strip reads back, so a send in a test writes and reports as it does in the app.
 */
export function useSavingOutbox(onSend: (attachments: RunAttachment[], steer: boolean) => void): ComposerOutbox {
  const [state, setState] = useState(NO_ATTACHMENT_SEND);
  return {
    state,
    notice: (message) => setState((current) => ({ ...current, error: message })),
    send: (attachments, steer) => {
      setState((current) => ({ ...current, busy: attachments.length > 0, error: null }));
      void attachmentEffects["send-attachments"](
        { type: "send-attachments", attachments, ...(steer ? { steer } : {}) },
        {
          desktop: window.desktop, storage: localStorage,
          environmentRefreshes: { current: new Map() },
          scheduleSnoozeExpiry: () => {},
          dispatch: async (input) => {
            if (input.type === "attachments.saved") {
              setState((current) => ({ ...current, busy: false, error: null, sent: input.ids }));
              onSend(input.attachments, input.steer ?? false);
            }
            if (input.type === "attachments.failed") setState((current) => ({ ...current, busy: false, error: input.message }));
          },
        },
      );
    },
  };
}
