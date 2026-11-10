/** What went wrong, in the words the window was handed. */
export function reportedMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What went wrong, without the wrapper Electron puts around a rejection crossing the bridge. */
export function errorMessage(error: unknown) {
  return reportedMessage(error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
