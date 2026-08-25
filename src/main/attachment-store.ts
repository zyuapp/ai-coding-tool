import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachmentName } from "../application/attachments.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentsDirectory() {
  return path.join(app.getPath("userData"), "attachments");
}

/** A renderer may only name files this app wrote into the attachments directory; anything else is null. */
export function savedAttachmentPath(file: string) {
  const name = attachmentName(file);
  if (!/^[A-Za-z0-9-]+\.png$/.test(name)) return null;
  const saved = path.join(attachmentsDirectory(), name);
  return path.resolve(file) === saved ? saved : null;
}

/** Puts base64 PNG bytes in the attachments directory under a name of this app's own making. */
export async function writeAttachment(data: string) {
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is empty or too large.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Attachment payload is not base64.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) throw new Error("Attachment is empty or too large.");
  const directory = attachmentsDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.png`);
  await writeFile(file, bytes);
  return file;
}
