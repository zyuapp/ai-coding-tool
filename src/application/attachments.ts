import type { RunAttachment } from "../domain/task.js";

const ATTACHMENT_HEADING = "Attached screenshots (numbered red boxes mark the areas in question):";

export function promptWithAttachments(text: string, attachments: RunAttachment[]) {
  if (attachments.length === 0) return text;
  const blocks = attachments.map((attachment) => {
    const marks = attachment.labels
      .map((label, index) => ({ label: label.trim(), mark: index + 1 }))
      .filter((entry) => entry.label.length > 0)
      .map((entry) => `  ${entry.mark}. ${entry.label}`);
    return [attachment.path, ...marks].join("\n");
  });
  return [text, `${ATTACHMENT_HEADING}\n${blocks.join("\n")}`].filter((part) => part.length > 0).join("\n\n");
}

export function taskTitleFor(text: string, attachments: RunAttachment[]) {
  const source = text || (attachments.length === 1 ? "Screenshot" : `${attachments.length} screenshots`);
  return source.length > 52 ? `${source.slice(0, 49)}…` : source;
}

export const ATTACHMENT_SCHEME = "attachment";

/** Attachments live in one flat directory, so the file name alone addresses them over the `attachment:` scheme. */
export function attachmentName(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? "";
}

export function attachmentUrl(filePath: string) {
  return `${ATTACHMENT_SCHEME}://file/${encodeURIComponent(attachmentName(filePath))}`;
}
