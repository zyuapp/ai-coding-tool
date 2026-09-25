import { nativeImage } from "electron";

const MAX_PIXELS = 64_000_000;

/** A preview cut from an image with the desktop's own decoder, or a refusal for one too large to decode. */
export function messageThumbnail(bytes: Buffer): Buffer {
  const decoded = nativeImage.createFromBuffer(bytes);
  const size = decoded.getSize();
  if (decoded.isEmpty() || size.width * size.height > MAX_PIXELS) throw new Error("Image cannot be previewed.");
  const scale = Math.min(1, 640 / size.width, 360 / size.height);
  return decoded.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
}
