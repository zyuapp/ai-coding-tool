import { parseFileHref } from "./markdown-links.js";

export const MESSAGE_IMAGE_SCHEME = "message-image";
export const MAX_MESSAGE_IMAGES = 20;

export function isMessageImageFile(file: string) {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(file);
}

/** Shared by the protocol handler and the paired computer's query boundary. */
export function isMessageImageReference(file: unknown, root: unknown, message: unknown): boolean {
  return typeof file === "string" && file.length <= 4096 && isMessageImageFile(file) && !/^[a-z][a-z\d+.-]*:\/\//i.test(file)
    && typeof root === "string" && root.length <= 4096
    && typeof message === "string" && message.length > 0 && message.length <= 256;
}

/** Only local raster images are previewed automatically. Web links keep their usual behaviour. */
export function messageImagePath(href: string) {
  const file = parseFileHref(href);
  return file && file.line === null && isMessageImageFile(file.file) ? file.file : null;
}

export function isCommitHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{7,40}$/i.test(value);
}

/** The message id keeps two replies linking the same filename from sharing a snapshot. */
export function messageImageUrl(file: string, root: string, messageId: string, thumbnail = false, taskId?: string) {
  const query = new URLSearchParams({ path: file, root, message: messageId });
  if (thumbnail) query.set("thumbnail", "1");
  if (taskId !== undefined) query.set("taskId", taskId);
  return `${MESSAGE_IMAGE_SCHEME}://file/?${query}`;
}

export function isImageSource(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16_384 && /^(?:attachment|message-image):\/\/file\//.test(value);
}
