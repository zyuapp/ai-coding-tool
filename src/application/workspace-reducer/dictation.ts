/** Dictating into the main composer: the recording, the words it brought back, and the send they ride. */
import { DICTATION_HEARD_NOTHING, dictationRefusal, withSpokenWords, type DictationState } from "../../domain/dictation.js";
import { MAIN_COMPOSER, NO_ATTACHMENT_SEND } from "../composer-attachments.js";
import { composerOf, focusComposerIn, withAttachmentSendIn, withPromptIn, type ComposerEdit } from "../composer-drafts.js";
import { promptKey, type WorkspaceState } from "../workspace-state.js";
import type { DictationSliceState } from "../state/dictation.js";
import type { SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import type { DictationModel } from "../../domain/dictation.js";

export const DICTATION_INPUTS = [
  "dictation.start", "dictation.hands-free", "dictation.stop", "dictation.cancel", "dictation.download", "dictation.cancel-download",
  "dictation.model", "dictation.started", "dictation.transcribed", "dictation.failed",
] as const;
type DictationInput = Extract<WorkspaceInput, { type: (typeof DICTATION_INPUTS)[number] }>;

/** Where this computer's speech model stands, and how a hold went. `id` names the hold. */
export type DictationEvent =
  | { type: "dictation.model"; model: DictationModel; message?: string; progress?: number }
  | { type: "dictation.started"; id: string }
  | { type: "dictation.transcribed"; id: string; text: string }
  | { type: "dictation.failed"; id: string; message: string };

/** The microphone and speech model. `stop` answers with the words heard since `start`. */
export type DictationEffect =
  | { type: "dictation.start"; id: string }
  | { type: "dictation.stop"; id: string }
  | { type: "dictation.cancel"; id: string }
  | { type: "dictation.download" }
  | { type: "dictation.cancel-download" };

type Own = DictationSliceState;

function withDictation(dictation: DictationState, patch: Partial<DictationState>): DictationState {
  return { ...dictation, ...patch };
}

/** What the hold has to say, on the line under the main composer that its own sends use. Null clears it. */
function noticed(composer: ComposerEdit, message: string | null): ComposerEdit {
  const held = composer.view.attachmentSends[MAIN_COMPOSER] ?? NO_ATTACHMENT_SEND;
  if (held.error === message) return composer;
  return withAttachmentSendIn(composer, MAIN_COMPOSER, { ...held, error: message });
}

function current(state: WorkspaceState, id: string) {
  const session = state.dictation.session;
  return session?.id === id ? session : null;
}

export function reduceDictation(state: WorkspaceState, input: DictationInput): SliceTransition<Own> {
  const { dictation } = state;
  switch (input.type) {
    case "dictation.start": {
      const refusal = dictationRefusal(dictation);
      if (refusal) return { refusal };
      if (dictation.session) return {};
      const session = { id: crypto.randomUUID(), key: promptKey(state), phase: "starting" as const, handsFree: false, send: false };
      return { patch: { dictation: withDictation(dictation, { session }) }, effects: [{ type: "dictation.start", id: session.id }] };
    }

    case "dictation.hands-free": {
      const session = dictation.session;
      if (!session || session.phase === "transcribing" || session.handsFree) return {};
      const freed = { dictation: withDictation(dictation, { session: { ...session, handsFree: true } }) };
      return session.key === promptKey(state) ? { patch: freed, composer: focusComposerIn(composerOf(state)) } : { patch: freed };
    }

    case "dictation.stop": {
      const session = dictation.session;
      if (!session || session.phase === "transcribing") return {};
      const stopped = { ...session, phase: "transcribing" as const, send: input.send === true };
      return { patch: { dictation: withDictation(dictation, { session: stopped }) }, effects: [{ type: "dictation.stop", id: session.id }] };
    }

    case "dictation.cancel": {
      const session = dictation.session;
      if (!session) return {};
      return { patch: { dictation: withDictation(dictation, { session: null }) }, effects: [{ type: "dictation.cancel", id: session.id }] };
    }

    case "dictation.download":
      if (dictation.model !== "missing" && dictation.model !== "failed") return {};
      return { patch: { dictation: withDictation(dictation, { model: "downloading", message: null, progress: 0 }) }, effects: [{ type: "dictation.download" }] };

    case "dictation.cancel-download":
      if (dictation.model !== "downloading") return {};
      return { patch: { dictation: withDictation(dictation, { model: "missing", message: null, progress: null }) }, effects: [{ type: "dictation.cancel-download" }] };

    case "dictation.model":
      return { patch: { dictation: withDictation(dictation, { model: input.model, message: input.message ?? null, progress: input.model === "downloading" ? input.progress ?? null : null }) } };

    case "dictation.started": {
      const session = current(state, input.id);
      if (!session || session.phase !== "starting") return {};
      return { patch: { dictation: withDictation(dictation, { session: { ...session, phase: "recording" } }) } };
    }

    case "dictation.failed": {
      if (!current(state, input.id)) return {};
      return { patch: { dictation: withDictation(dictation, { session: null }) }, composer: noticed(composerOf(state), input.message) };
    }

    /**
     * The words join the draft the recording began on, to be read over and sent like typing. A draft
     * still on screen takes the caret, so Enter sends it, or is sent when the recording was stopped to send.
     */
    case "dictation.transcribed": {
      const session = current(state, input.id);
      if (!session) return {};
      const ended = withDictation(dictation, { session: null });
      if (!input.text.trim()) return { patch: { dictation: ended }, composer: noticed(composerOf(state), DICTATION_HEARD_NOTHING) };
      const written = noticed(withPromptIn(composerOf(state), session.key, withSpokenWords(state.prompts[session.key] ?? "", input.text)), null);
      if (session.key !== promptKey(state)) return { patch: { dictation: ended }, composer: written };
      return session.send
        ? { patch: { dictation: withDictation(ended, { sends: ended.sends + 1 }) }, composer: written }
        : { patch: { dictation: ended }, composer: focusComposerIn(written) };
    }
  }
}
