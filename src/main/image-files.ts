import { open } from "node:fs/promises";

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Bound the read on an open handle even if the original changes during capture. */
export async function readImageFile(file: string) {
  const handle = await open(file, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_IMAGE_BYTES) throw new Error("Image is too large or unavailable.");
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Image changed while reading.");
      offset += bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}
