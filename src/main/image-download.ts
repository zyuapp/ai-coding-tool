import { app, dialog, type BrowserWindow } from "electron";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { isImageSource, MESSAGE_IMAGE_SCHEME } from "../domain/message-artifacts.js";
import { attachmentsDirectory, savedAttachmentPath } from "./attachment-store.js";
import { preserveMessageImage } from "./message-image-store.js";

/** Save the same retained original the preview displays, even if its source has since disappeared. */
export async function downloadImage(owner: BrowserWindow, source: unknown) {
  if (!isImageSource(source)) throw new Error("Invalid image reference.");
  const url = new URL(source);
  const query = url.searchParams;
  const original = url.protocol === `${MESSAGE_IMAGE_SCHEME}:`
    ? await preserveMessageImage(query.get("path"), query.get("root"), query.get("message"))
    : savedAttachmentPath(path.join(attachmentsDirectory(), decodeURIComponent(url.pathname.slice(1))));
  if (!original) throw new Error("This image is no longer available.");
  const extension = path.extname(original).slice(1);
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: "Save image",
    defaultPath: path.join(app.getPath("downloads"), `image.${extension}`),
    filters: [{ name: "Image", extensions: [extension] }],
  });
  if (!canceled && filePath) await copyFile(original, filePath);
}
