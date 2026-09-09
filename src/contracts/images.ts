/** Desktop storage and export for images shown in conversations. */
export type ImageDesktopAPI = {
  /** Writes base64 PNG bytes into the attachments directory and resolves with the absolute path. */
  saveAttachment(data: string, original?: string): Promise<string>;
  /** Reads one back as base64 PNG bytes. Only files this app wrote are readable. */
  readAttachment(file: string): Promise<string>;
  /** Capture-time context, if present. Annotated copies inherit it from their original image. */
  readAttachmentContext(file: string): Promise<ScreenshotContext | null>;
  preserveMessageImages(files: string[], root: string, messageId: string): Promise<void>;
  /** Prompts for a destination and saves the retained original shown by the viewer. */
  downloadImage(source: string): Promise<void>;
};
import type { ScreenshotContext } from "../domain/screenshot-context.js";
