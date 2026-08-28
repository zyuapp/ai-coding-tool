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
