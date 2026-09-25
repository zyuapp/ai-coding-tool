import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_MESSAGE_IMAGES, isMessageImageReference } from "../domain/message-artifacts.js";
import { MAX_IMAGE_BYTES, readImageFile } from "./image-files.js";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const pending = new Map<string, Promise<string>>();
let decodeQueue: Promise<unknown> = Promise.resolve();

/** Where copies go, and how a preview is cut from one. A host with no image decoder keeps no previews. */
export type MessageImageStore = {
  directory: string;
  thumbnail: (bytes: Buffer) => Buffer | null;
};

let store: MessageImageStore | null = null;

export function useMessageImageStore(configured: MessageImageStore) {
  store = configured;
}

function configured() {
  if (!store) throw new Error("The message image store has not been set.");
  return store;
}

function imageRequest(file: unknown, root: unknown, messageId: unknown) {
  if (typeof file !== "string" || typeof root !== "string" || !isMessageImageReference(file, root, messageId)) throw new Error("Invalid image reference.");
  const extension = path.extname(file).slice(1).toLowerCase();
  const key = createHash("sha256").update(JSON.stringify([messageId, file])).digest("hex");
  return { file, root, key, extension, directory: configured().directory };
}

/** Only images referenced in replies are retained; browser captures that are never used stay temporary. */
async function copyImage(request: ReturnType<typeof imageRequest>, load?: () => Promise<Buffer>) {
  const destination = path.join(request.directory, `${request.key}.${request.extension}`);
  if (await stat(destination).then((entry) => entry.isFile(), () => false)) return destination;
  // Network waits must not hold up this computer's thumbnail decoder.
  const remote = load ? await load() : null;
  const saving = decodeQueue.then(async () => {
    const { openableFile } = await import("./path-policy.mjs");
    const bytes = remote ?? await readImageFile(await openableFile(request.root ? [request.root] : [], request.file));
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is too large or unavailable.");
    const thumbnail = configured().thumbnail(bytes);
    await mkdir(request.directory, { recursive: true });
    if (thumbnail) await writeFile(path.join(request.directory, `${request.key}-thumb.png`), thumbnail);
    const staging = `${destination}.tmp`;
    await writeFile(staging, bytes);
    await rename(staging, destination);
    return destination;
  });
  decodeQueue = saving.catch(() => undefined);
  return saving;
}

export async function preserveMessageImage(file: unknown, root: unknown, messageId: unknown, load?: () => Promise<Buffer>) {
  const request = imageRequest(file, root, messageId);
  let copying = pending.get(request.key);
  if (!copying) {
    copying = copyImage(request, load);
    pending.set(request.key, copying);
    void copying.finally(() => pending.delete(request.key)).catch(() => undefined);
  }
  return copying;
}

export async function preserveMessageImages(files: unknown, root: unknown, messageId: unknown) {
  if (!Array.isArray(files) || files.length > MAX_MESSAGE_IMAGES) throw new Error("Invalid image references.");
  /** Decode one at a time, so a reply of full-page captures cannot multiply peak memory use. */
  for (const file of files) await preserveMessageImage(file, root, messageId).catch(() => undefined);
}

/** Headless holders have no decoder; a thumbnail request can still read their original. */
export async function readMessageImage(file: unknown, root: unknown, messageId: unknown, thumbnail = false) {
  const request = imageRequest(file, root, messageId);
  const original = await preserveMessageImage(file, root, messageId);
  if (thumbnail) {
    try {
      return { bytes: await readImageFile(path.join(request.directory, `${request.key}-thumb.png`)), contentType: "image/png" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { bytes: await readImageFile(original), contentType: MIME[request.extension]! };
}

/** Validate transferred originals before retaining them under the same snapshot key. */
export function messageImageBytes(value: unknown, file: string): Buffer {
  if (!value || typeof value !== "object" || !("data" in value) || !("contentType" in value)
    || value.contentType !== MIME[path.extname(file).slice(1).toLowerCase()]
    || typeof value.data !== "string" || !value.data.length || value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error("Invalid image bytes.");
  const bytes = Buffer.from(value.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is too large or unavailable.");
  return bytes;
}

export async function messageImageResponse(url: string) {
  try {
    const query = new URL(url).searchParams;
    const { bytes, contentType } = await readMessageImage(query.get("path"), query.get("root"), query.get("message"), query.get("thumbnail") === "1");
    return new Response(bytes, { headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Image unavailable", { status: 404 });
  }
}
