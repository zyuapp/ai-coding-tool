import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_MESSAGE_IMAGES, isMessageImageFile } from "../domain/message-artifacts.js";
import { readImageFile } from "./image-files.js";

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
  if (typeof file !== "string" || file.length > 4096 || !isMessageImageFile(file) || /^[a-z][a-z\d+.-]*:\/\//i.test(file)
    || typeof root !== "string" || root.length > 4096
    || typeof messageId !== "string" || !messageId || messageId.length > 256) throw new Error("Invalid image reference.");
  const extension = path.extname(file).slice(1).toLowerCase();
  const key = createHash("sha256").update(JSON.stringify([messageId, file])).digest("hex");
  return { file, root, key, extension, directory: configured().directory };
}

/** Only images referenced in replies are retained; browser captures that are never used stay temporary. */
async function copyImage(request: ReturnType<typeof imageRequest>) {
  const destination = path.join(request.directory, `${request.key}.${request.extension}`);
  if (await stat(destination).then((entry) => entry.isFile(), () => false)) return destination;
  const { openableFile } = await import("./path-policy.mjs");
  const source = await openableFile(request.root ? [request.root] : [], request.file);
  const bytes = await readImageFile(source);
  const thumbnail = configured().thumbnail(bytes);
  await mkdir(request.directory, { recursive: true });
  if (thumbnail) await writeFile(path.join(request.directory, `${request.key}-thumb.png`), thumbnail);
  const staging = `${destination}.tmp`;
  await writeFile(staging, bytes);
  await rename(staging, destination);
  return destination;
}

export async function preserveMessageImage(file: unknown, root: unknown, messageId: unknown) {
  const request = imageRequest(file, root, messageId);
  let copying = pending.get(request.key);
  if (!copying) {
    copying = decodeQueue.then(() => copyImage(request));
    decodeQueue = copying.catch(() => undefined);
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

export async function messageImageResponse(url: string) {
  try {
    const query = new URL(url).searchParams;
    const request = imageRequest(query.get("path"), query.get("root"), query.get("message"));
    const original = await preserveMessageImage(request.file, request.root, query.get("message"));
    const thumbnail = query.get("thumbnail") === "1";
    const bytes = await readFile(thumbnail ? path.join(request.directory, `${request.key}-thumb.png`) : original);
    return new Response(bytes, { headers: {
      "Content-Type": thumbnail ? "image/png" : MIME[request.extension]!,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Image unavailable", { status: 404 });
  }
}
