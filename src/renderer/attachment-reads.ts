import type { ScreenshotContext } from "../domain/screenshot-context";

/** Reads a file this app already wrote into the attachments directory back out as a data URL. */
export async function attachmentDataUrl(path: string) {
  return `data:image/png;base64,${await window.desktop.readAttachment(path)}`;
}

/** What was on screen around a staged screenshot, or null when it was captured without any. */
export function attachmentContext(path: string): Promise<ScreenshotContext | null> {
  return window.desktop.readAttachmentContext(path);
}
