import type { PastedText } from "../domain/conversation.js";

/** A paste past either of these fills the composer rather than reading as a sentence, so it rides as a pill. */
export const PASTE_PILL_LINES = 12;
export const PASTE_PILL_CHARS = 900;

export function pasteRidesAsPill(text: string) {
  return text.trim().length > 0 && (lineCount(text) > PASTE_PILL_LINES || text.length > PASTE_PILL_CHARS);
}

export function lineCount(text: string) {
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
  return lines;
}

/** What a pill says it holds: lines for anything with a shape, characters for one long run of text. */
export function pasteSummary(text: string) {
  const lines = lineCount(text);
  return lines > 1 ? `${lines.toLocaleString()} lines` : `${text.length.toLocaleString()} characters`;
}

/** What a thread pasted into with nothing typed is called: the first line that says something. */
export function pasteTitle(pastes: PastedText[]) {
  const text = pastes[0]?.text;
  if (!text) return "";
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end === -1 ? text.length : end).trim();
    if (line) return line;
    if (end === -1) return "";
    start = end + 1;
  }
  return "";
}

const PASTE_HEADING = "Text I pasted into my message, in the order I pasted it:";

/** How pasted blocks reach the agent. The stored message keeps them apart; only the prompt is flat. */
export function promptWithPastes(text: string, pastes: PastedText[]) {
  if (pastes.length === 0) return text;
  const blocks = pastes.map((paste, index) => `Pasted text #${index + 1}:\n${paste.text}`);
  return [text, `${PASTE_HEADING}\n\n${blocks.join("\n\n")}`].filter((part) => part.length > 0).join("\n\n");
}
