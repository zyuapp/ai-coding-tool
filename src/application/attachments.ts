import type { RunAttachment } from "../domain/conversation.js";
import { clampTitle } from "../domain/thread.js";

const ATTACHMENT_HEADING = "Attached screenshots (numbered red boxes mark the areas in question):";

/**
 * The letter every mark on one screenshot carries, so a mark names itself across a send of several.
 * A lone screenshot needs no letter, since its numbers are already unambiguous.
 */
export function markPrefix(index: number, total: number) {
  return total > 1 ? String.fromCharCode("A".charCodeAt(0) + (index % 26)) : "";
}

export function promptWithAttachments(text: string, attachments: RunAttachment[]) {
  if (attachments.length === 0) return text;
  const blocks = attachments.map((attachment, at) => {
    const prefix = markPrefix(at, attachments.length);
    const marks = attachment.labels
      .map((label, index) => ({ label: label.trim(), mark: `${prefix}${index + 1}` }))
      .filter((entry) => entry.label.length > 0)
      .map((entry) => `  ${entry.mark}. ${entry.label}`);
    const count = attachment.labels.length;
    const span = prefix && count > 0
      ? count > 1 ? ` (marks ${prefix}1\u2013${prefix}${count})` : ` (mark ${prefix}1)`
      : "";
    return [`${attachment.path}${span}`, ...marks].join("\n");
  });
  return [text, `${ATTACHMENT_HEADING}\n${blocks.join("\n")}`].filter((part) => part.length > 0).join("\n\n");
}

export function taskTitleFor(text: string, attachments: RunAttachment[]) {
  return clampTitle(text || (attachments.length === 1 ? "Screenshot" : `${attachments.length} screenshots`));
}

export const ATTACHMENT_SCHEME = "attachment";

/** Attachments live in one flat directory, so the file name alone addresses them over the `attachment:` scheme. */
export function attachmentName(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? "";
}

export function attachmentUrl(filePath: string) {
  return `${ATTACHMENT_SCHEME}://file/${encodeURIComponent(attachmentName(filePath))}`;
}
