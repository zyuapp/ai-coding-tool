import type { ImageGenerationItem } from "./protocol/ImageGenerationItem.js";

export type ImageOutput = (item: ImageGenerationItem, root: string) => Promise<string>;

/** Keep binary payloads in main; the transcript receives a local link backed by the image store. */
export const codexImageOutput: ImageOutput = async (item, root) => {
  if (item.failure?.type === "usageLimitExceeded") return "Image generation failed: the Codex image-generation usage limit has been reached.";
  if (item.status === "failed") return "Image generation failed. Codex did not return an image.";
  if (item.status === "cancelled" || item.status === "interrupted") return "Image generation was cancelled.";

  const { preserveMessageImage } = await import("../message-image-store.js");
  let file = item.savedPath;
  if (file) {
    try {
      await preserveMessageImage(file, root, item.id);
    } catch (error) {
      if (!item.result) throw error;
      file = undefined;
    }
  }
  if (!file) {
    if (!item.result) return "Image generation finished without returning an image.";
    const { writeAttachment } = await import("../attachment-store.js");
    file = await writeAttachment(item.result);
    await preserveMessageImage(file, root, item.id);
  }
  // Encode each segment so spaces, percent signs and Markdown delimiters remain literal filenames.
  const href = file.split("/").map(encodeURIComponent).join("/");
  return `[Generated image](<${href}>)`;
};
