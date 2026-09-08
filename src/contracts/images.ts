/** Desktop storage and export for images shown in conversations. */
export type ImageDesktopAPI = {
  /** Writes base64 PNG bytes into the attachments directory and resolves with the absolute path. */
  saveAttachment(data: string): Promise<string>;
  /** Reads one back as base64 PNG bytes. Only files this app wrote are readable. */
  readAttachment(file: string): Promise<string>;
  preserveMessageImages(files: string[], root: string, messageId: string): Promise<void>;
  /** Prompts for a destination and saves the retained original shown by the viewer. */
  downloadImage(source: string): Promise<void>;
};
