import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachmentName } from "../application/attachments.js";
import { isScreenshotContext, type ScreenshotContext } from "../domain/screenshot-context.js";

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
export async function writeAttachment(data: string, context?: ScreenshotContext | null) {
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is empty or too large.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Attachment payload is not base64.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) throw new Error("Attachment is empty or too large.");
  const directory = attachmentsDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.png`);
  await writeFile(file, bytes);
  // Context is optional: a sidecar storage failure must not discard a successful screenshot.
  if (context) await writeFile(`${file}.context.json`, JSON.stringify(context)).catch(() => undefined);
  return file;
}

/** Immutable context follows the PNG path across drafts, history, and app restarts. */
export async function readAttachmentContext(file: string): Promise<ScreenshotContext | null> {
  const saved = savedAttachmentPath(file);
  if (!saved) return null;
  try {
    const handle = await open(`${saved}.context.json`, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > 128_000) return null;
      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return null;
        offset += bytesRead;
      }
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      return isScreenshotContext(value) ? value : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
