import { stat } from "node:fs/promises";
import { clampTitle } from "../../domain/task.js";

/** How much of a first message a title is read from. */
export const TITLE_MESSAGE_LIMIT = 2_000;

export const TITLE_INSTRUCTIONS = "You name chat threads. Answer with a title of at most six words describing what the message and any screenshots with it are about, and nothing else: no quotes, no trailing punctuation, no preamble.";

/** What the writer is asked, given the message; a message with only screenshots asks about those. */
export function titleQuestion(text: string) {
  return text.trim()
    ? `Name this thread.\n\n<message>\n${text.slice(0, TITLE_MESSAGE_LIMIT)}\n</message>`
    : "Name this thread from the screenshots it starts with.";
}

/** The first line the writer answered with, stripped of quoting and cut to a title's length. */
export function cleanTitle(text: string) {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return clampTitle(line.replace(/^["'`]+|["'`]+$/g, "").replace(/\.+$/, ""));
}

/** How many screenshots ride along with a first message, and how large each may be. */
const IMAGE_LIMIT = 2;
export const IMAGE_BYTE_LIMIT = 1024 * 1024;

/** The screenshots a writer is handed: the first few, and only those that are files of a size worth sending. */
export async function readableImages(attachments: string[]): Promise<string[]> {
  const checked = await Promise.all(attachments.slice(0, IMAGE_LIMIT).map(async (file) => {
    try {
      const metadata = await stat(file);
      return metadata.isFile() && metadata.size > 0 && metadata.size <= IMAGE_BYTE_LIMIT ? file : null;
    } catch {
      return null;
    }
  }));
  return checked.filter((file): file is string => file !== null);
}
