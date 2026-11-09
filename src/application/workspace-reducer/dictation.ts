/** Holding to talk into the main composer: the hold, the words it brought back, and the send they ride. */
import { DICTATION_HEARD_NOTHING, dictationRefusal, withSpokenWords, type DictationState } from "../../domain/dictation.js";
import { MAIN_COMPOSER, NO_ATTACHMENT_SEND } from "../composer-attachments.js";
import { focusComposer } from "../composer-drafts.js";
import { promptKey, withPrompt, type WorkspaceState } from "../workspace-state.js";
import { rejected, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";

export const DICTATION_INPUTS = [
  "dictation.start", "dictation.stop", "dictation.cancel", "dictation.download", "dictation.cancel-download",
  "dictation.model", "dictation.started", "dictation.transcribed", "dictation.failed",
] as const;
type DictationInput = Extract<WorkspaceInput, { type: (typeof DICTATION_INPUTS)[number] }>;

function withDictation(state: WorkspaceState, patch: Partial<DictationState>): WorkspaceState {
  return { ...state, dictation: { ...state.dictation, ...patch } };
}

/** What the hold has to say, on the line under the main composer that its own sends use. Null clears it. */
function noticed(state: WorkspaceState, message: string | null): WorkspaceState {
  const held = state.attachmentSends[MAIN_COMPOSER] ?? NO_ATTACHMENT_SEND;
  if (held.error === message) return state;
  return { ...state, attachmentSends: { ...state.attachmentSends, [MAIN_COMPOSER]: { ...held, error: message } } };
}

function current(state: WorkspaceState, id: string) {
  const session = state.dictation.session;
  return session?.id === id ? session : null;
}

export function reduceDictation(state: WorkspaceState, input: DictationInput): WorkspaceTransition {
  switch (input.type) {
    case "dictation.start": {
      const refusal = dictationRefusal(state.dictation);
      if (refusal) return rejected(state, refusal);
      if (state.dictation.session) return settled(state);
      const session = { id: crypto.randomUUID(), key: promptKey(state), phase: "starting" as const };
      return settled(withDictation(state, { session }), [{ type: "dictation.start", id: session.id }]);
    }

    case "dictation.stop": {
      const session = state.dictation.session;
      if (!session || session.phase === "transcribing") return settled(state);
      return settled(withDictation(state, { session: { ...session, phase: "transcribing" } }), [{ type: "dictation.stop", id: session.id }]);
    }

    case "dictation.cancel": {
      const session = state.dictation.session;
      if (!session) return settled(state);
      return settled(withDictation(state, { session: null }), [{ type: "dictation.cancel", id: session.id }]);
    }

    case "dictation.download":
      if (state.dictation.model !== "missing" && state.dictation.model !== "failed") return settled(state);
      return settled(withDictation(state, { model: "downloading", message: null, progress: 0 }), [{ type: "dictation.download" }]);

    case "dictation.cancel-download":
      if (state.dictation.model !== "downloading") return settled(state);
      return settled(withDictation(state, { model: "missing", message: null, progress: null }), [{ type: "dictation.cancel-download" }]);

    case "dictation.model":
      return settled(withDictation(state, { model: input.model, message: input.message ?? null, progress: input.model === "downloading" ? input.progress ?? null : null }));

    case "dictation.started": {
      const session = current(state, input.id);
      if (!session || session.phase !== "starting") return settled(state);
      return settled(withDictation(state, { session: { ...session, phase: "recording" } }));
    }

    case "dictation.failed": {
      if (!current(state, input.id)) return settled(state);
      return settled(noticed(withDictation(state, { session: null }), input.message));
    }

    /**
     * The words join the draft the hold began on, to be read over and sent like typing. A draft still
     * on screen takes the caret, so Enter sends it.
     */
    case "dictation.transcribed": {
      const session = current(state, input.id);
      if (!session) return settled(state);
      const ended = withDictation(state, { session: null });
      if (!input.text.trim()) return settled(noticed(ended, DICTATION_HEARD_NOTHING));
      const written = noticed(withPrompt(ended, session.key, withSpokenWords(ended.prompts[session.key] ?? "", input.text)), null);
      return settled(session.key === promptKey(written) ? focusComposer(written) : written);
    }
  }
}
