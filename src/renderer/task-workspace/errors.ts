/** What went wrong, without the wrapper Electron puts around a rejection crossing the bridge. */
export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
