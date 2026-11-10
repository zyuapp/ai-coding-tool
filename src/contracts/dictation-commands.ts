import { optionalBoolean, type Declarations } from "./command-declaration.js";

/**
 * Dictating into the main composer. Starting opens the microphone; stopping turns what was heard into
 * words after the draft; cancelling drops the recording.
 */
export type DictationCommand =
  | { type: "dictation.start" }
  /** Keeps the recording going after the press that started it ends. */
  | { type: "dictation.hands-free" }
  /** `send` sends the draft once the words are in it. */
  | { type: "dictation.stop"; send?: boolean }
  | { type: "dictation.cancel" }
  /** Fetches the speech model into the folder other apps using it share. */
  | { type: "dictation.download" }
  /** Stops a download under way and drops what it fetched. */
  | { type: "dictation.cancel-download" };

export const dictationCommands = {
  "dictation.start": { fields: {}, at: "local" },
  "dictation.hands-free": { fields: {}, at: "local" },
  "dictation.stop": { fields: { send: optionalBoolean }, at: "local" },
  "dictation.cancel": { fields: {}, at: "local" },
  "dictation.download": { fields: {}, at: "local" },
  "dictation.cancel-download": { fields: {}, at: "local" },
} satisfies Declarations<DictationCommand>;
