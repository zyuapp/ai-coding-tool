import type { SettingsSection } from "../../domain/settings-section.js";

/** Whether the stored threads have loaded and can be written. */
export type StoreState = {
  /** `hiddenThreads` counts the threads on disk this build cannot read, which stay there untouched. */
  storageError: string | null; hiddenThreads: number;
  writable: boolean;
  /** Whether the stored threads have answered. Until they have, there is nothing to say is empty. */
  restored: boolean;
};

export function initialStoreState(storageError: string | null): StoreState {
  return { storageError, hiddenThreads: 0, writable: storageError === null, restored: false };
}

/** The last thing the user asked for that could not be done. */
export type ErrorsState = {
  actionError: string | null;
  /** The settings page that clears the error above, when one does. */
  actionErrorPage: SettingsSection | null;
};

export function initialErrorsState(): ErrorsState {
  return { actionError: null, actionErrorPage: null };
}
