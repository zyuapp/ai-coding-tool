import { NO_DICTATION, type DictationState } from "../../domain/dictation.js";

export type DictationSliceState = { dictation: DictationState };

export function initialDictationState(): DictationSliceState {
  return { dictation: NO_DICTATION };
}
