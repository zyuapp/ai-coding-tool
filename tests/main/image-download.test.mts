import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, test, vi } from "vitest";
import { attachmentUrl } from "../../src/application/attachments.ts";
import { messageImageUrl } from "../../src/domain/message-artifacts.ts";

const host = vi.hoisted(() => ({ root: "", destination: "", canceled: false, dialogs: [] as unknown[] }));
vi.mock("electron", () => ({
  app: { getPath: () => host.root },
  dialog: { showSaveDialog: async (_owner: unknown, options: unknown) => {
    host.dialogs.push(options);
    return { canceled: host.canceled, filePath: host.destination };
  } },
  nativeImage: { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 1600, height: 1200 }),
    resize: () => ({ toPNG: () => Buffer.from("thumbnail") }),
  }) },
}));

const { downloadImage } = await import("../../src/main/image-download.ts");
const { writeAttachment } = await import("../../src/main/attachment-store.ts");
const { preserveMessageImage } = await import("../../src/main/message-image-store.ts");
const owner = {} as BrowserWindow;
const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

beforeEach(async () => {
  host.root = await mkdtemp(path.join(os.tmpdir(), "aic-image-download-"));
  host.destination = path.join(host.root, "download.png");
  host.canceled = false;
  host.dialogs = [];
});
afterEach(async () => { await rm(host.root, { recursive: true, force: true }); });

test("downloading saves the retained full-resolution image after its original disappears", async () => {
  const file = path.join(host.root, "generated.png");
  await writeFile(file, original);
  await preserveMessageImage(file, "", "image-reply");
  await rm(file);
  await downloadImage(owner, messageImageUrl(file, "", "image-reply", true));
  assert.deepEqual(await readFile(host.destination), original);
  assert.deepEqual(host.dialogs, [{ title: "Save image", defaultPath: path.join(host.root, "image.png"), filters: [{ name: "Image", extensions: ["png"] }] }]);
});

test("attachments download unchanged and cancelling does not replace a selected file", async () => {
  const file = await writeAttachment(original.toString("base64"));
  await downloadImage(owner, attachmentUrl(file));
  assert.deepEqual(await readFile(host.destination), original);
  await writeFile(host.destination, "keep this file");
  host.canceled = true;
  await downloadImage(owner, attachmentUrl(file));
  assert.equal(await readFile(host.destination, "utf8"), "keep this file");
});

test("downloads reject unsupported sources and attachment paths outside the image store", async () => {
  for (const source of ["https://example.com/image.png", "file:///etc/passwd", "attachment://file/%2E%2E%2Fimage.png"]) {
    await assert.rejects(downloadImage(owner, source));
  }
  assert.deepEqual(host.dialogs, []);
});
