/** Holding to talk: the speech model this computer has, and the one recording the main composer is taking. */

/** Whether this computer can turn speech into text, and where getting its model stands. */
export type DictationModel = "unsupported" | "missing" | "downloading" | "ready" | "failed";

/** A recording is starting the microphone, hearing, or being turned into words. */
export type DictationPhase = "starting" | "recording" | "transcribing";

/** One hold. `key` is the draft its words go to, fixed when the hold began. */
export type DictationSession = { id: string; key: string; phase: DictationPhase };

export type DictationState = {
  model: DictationModel;
  /** Why the model is unsupported or failed. */
  message: string | null;
  session: DictationSession | null;
  /** Bumped when spoken words are in a draft and its composer should send it. */
  release: { key: string; count: number };
};

export const NO_DICTATION: DictationState = { model: "unsupported", message: null, session: null, release: { key: "", count: 0 } };

/** How long the send button must be held before it listens rather than sends. */
export const DICTATION_HOLD_MS = 250;

/** The longest recording a phone may send: two minutes of 16 kHz, 16-bit mono WAV. */
export const MAX_DICTATION_SECONDS = 120;
export const MAX_DICTATION_AUDIO_BYTES = 16_000 * 2 * MAX_DICTATION_SECONDS + 4_096;
const MAX_DICTATION_BASE64_LENGTH = Math.ceil(MAX_DICTATION_AUDIO_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isDictationAudio(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DICTATION_BASE64_LENGTH && value.length % 4 === 0 && BASE64.test(value);
}

export const DICTATION_UNSUPPORTED = "Dictation needs a Mac with Apple silicon.";
export const DICTATION_MISSING = "Download the speech model in Settings → General to dictate.";
export const DICTATION_DOWNLOADING = "The speech model is still downloading.";
export const DICTATION_HEARD_NOTHING = "Didn't catch anything, so nothing was sent.";

/** Why a hold cannot start, or null when it can. */
export function dictationRefusal(state: Pick<DictationState, "model" | "message">): string | null {
  switch (state.model) {
    case "ready": return null;
    case "missing": return DICTATION_MISSING;
    case "downloading": return DICTATION_DOWNLOADING;
    case "failed": return state.message ?? DICTATION_MISSING;
    case "unsupported": return state.message ?? DICTATION_UNSUPPORTED;
  }
}

/** Spoken words follow whatever was typed, on the same line unless the typing ended one. */
export function withSpokenWords(typed: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return typed;
  if (!typed.trim()) return words;
  return /\s$/.test(typed) ? `${typed}${words}` : `${typed} ${words}`;
}
