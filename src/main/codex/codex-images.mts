import type { ImageGenerationItem } from "./protocol/ImageGenerationItem.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMessageImageFile } from "../../domain/message-artifacts.js";
import { MAX_IMAGE_BYTES, readImageFile } from "../image-files.js";
import { openableFile } from "../path-policy.mjs";

export type ImageOutput = (item: ImageGenerationItem, root: string) => Promise<string>;

/** The agent utility process saves with Node APIs; only the main process decodes previews. */
export async function codexImageOutput(item: ImageGenerationItem, root: string, directory?: string): Promise<string> {
  if (item.failure?.type === "usageLimitExceeded") return "Image generation failed: the Codex image-generation usage limit has been reached.";
  if (item.status === "failed") return "Image generation failed. Codex did not return an image.";
  if (item.status === "cancelled" || item.status === "interrupted") return "Image generation was cancelled.";

  if (!item.savedPath && !item.result) return "Image generation finished without returning an image.";
  if (!directory || !path.isAbsolute(directory)) throw new Error("Generated image storage is unavailable.");
  let bytes: Buffer | undefined;
  let extension = ".png";
  if (item.savedPath) {
    try {
      if (!isMessageImageFile(item.savedPath)) throw new Error("Unsupported image file type.");
      bytes = await readImageFile(await openableFile(root ? [root] : [], item.savedPath));
      extension = path.extname(item.savedPath).toLowerCase();
    } catch (error) {
      if (!item.result) throw error;
    }
  }
  if (!bytes) {
    if (item.result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Image is too large.");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)) throw new Error("Image payload is not base64.");
    bytes = Buffer.from(item.result, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is empty or too large.");
  }
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}${extension}`);
  await writeFile(file, bytes, { flag: "wx" });
  // Encode each segment so spaces, percent signs and Markdown delimiters remain literal filenames.
  const href = file.split("/").map(encodeURIComponent).join("/");
  return `[Generated image](<${href}>)`;
}
