import type { AppCommand } from "../contracts/commands";
import type { StagedImage } from "../domain/conversation";

/** How wide or tall a dropped image may be before it is scaled down to be kept. */
const MAX_IMAGE_EDGE = 4_096;

/** Where a composer's images came from, so a second drop of one is neither copied nor staged again. */
export function imageSources(images: StagedImage[]) {
  return images.flatMap((image) => image.source ?? []);
}

export function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read that file.")));
    reader.readAsDataURL(file);
  });
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("That image could not be read.")));
    image.src = source;
  });
}

/**
 * A dropped image as base64 PNG bytes, which is what the attachments directory holds. A PNG is kept
 * as it is; anything else is drawn once so every staged image is one format the composer can draw on.
 */
async function pngPayload(file: File) {
  const source = await readDataUrl(file);
  const image = await loadImage(source);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  if (file.type === "image/png" && scale === 1) return source.replace(/^data:[^,]*,/, "");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("That image could not be read.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").replace(/^data:[^,]*,/, "");
}

/** Puts a dropped image where the composer's own images live, so it can be annotated like them. */
async function stageImage(file: File) {
  return window.desktop.saveAttachment(await pngPayload(file));
}

/**
 * What a drop or a paste of files does. An image is copied into the app's own images, so it shows a
 * preview and can be drawn on. Everything else, folders included, is named by where it already sits.
 */
export async function attachDroppedFiles(files: File[], threadId: string | undefined, dispatch: (command: AppCommand) => void, staged: string[] = []) {
  const target = threadId === undefined ? {} : { taskId: threadId };
  const named: string[] = [];
  const held = new Set(staged);
  for (const file of files) {
    const source = window.desktop.pathForFile(file);
    /** One the composer already holds is left alone, so no second copy of it is ever written. */
    if (source && held.has(source)) continue;
    if (isImageFile(file)) {
      const path = await stageImage(file).catch(() => null);
      if (path !== null) {
        if (source) held.add(source);
        dispatch({ type: "image.add", ...target, path, label: file.name, ...(source ? { source } : {}) });
        continue;
      }
    }
    /** An image too big to keep, or anything that is not one, still has a place on this machine. */
    if (source) named.push(source);
  }
  if (named.length === 0) return;
  const described = await window.desktop.describeFiles(named).catch(() => []);
  if (described.length > 0) dispatch({ type: "file.attach", ...target, files: described });
}
