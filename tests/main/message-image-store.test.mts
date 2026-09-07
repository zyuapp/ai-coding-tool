import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { messageImageUrl } from "../../src/domain/message-artifacts.ts";

const imageHost = vi.hoisted(() => ({ root: "", sizes: [] as Array<{ width: number; height: number }> }));
vi.mock("electron", () => ({
  app: { getPath: () => imageHost.root },
  nativeImage: { createFromBuffer: (bytes: Buffer) => ({
    isEmpty: () => bytes[0] !== 137,
    getSize: () => ({ width: 1600, height: 1200 }),
    resize: (size: { width: number; height: number }) => { imageHost.sizes.push(size); return { toPNG: () => Buffer.from("thumbnail") }; },
  }) },
}));

afterEach(async () => { if (imageHost.root) await rm(imageHost.root, { recursive: true, force: true }); });

test("a referenced screenshot survives deletion and a fresh store, while later replies capture their own version", async () => {
  imageHost.root = await mkdtemp(path.join(os.tmpdir(), "aic-message-images-"));
  imageHost.sizes = [];
  const file = path.join(imageHost.root, "shot with spaces 100%.png");
  const bytes = Buffer.from([137, 80, 78, 71, 1]);
  await writeFile(file, bytes);
  const store = await import("../../src/main/message-image-store.ts");
  const [first, again] = await Promise.all([store.preserveMessageImage(file, "", "reply-1"), store.preserveMessageImage(file, "", "reply-1")]);
  assert.equal(first, again);
  assert.deepEqual(await readFile(first), bytes);
  assert.deepEqual(imageHost.sizes, [{ width: 480, height: 360 }]);
  await rm(file);
  vi.resetModules();
  const restarted = await import("../../src/main/message-image-store.ts");
  const response = await restarted.messageImageResponse(messageImageUrl(file, "", "reply-1"));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const thumbnail = await restarted.messageImageResponse(messageImageUrl(file, "", "reply-1", true));
  assert.equal(await thumbnail.text(), "thumbnail");
  assert.equal((await restarted.messageImageResponse(messageImageUrl(file, "", "reply-2"))).status, 404);
  const changed = Buffer.from([137, 80, 78, 71, 2]);
  await writeFile(file, changed);
  assert.deepEqual(await readFile(await restarted.preserveMessageImage(file, "", "reply-2")), changed);
  assert.deepEqual(await readFile(first), bytes);
});

test("unavailable and invalid image references fail as previews without blocking other images", async () => {
  imageHost.root = await mkdtemp(path.join(os.tmpdir(), "aic-message-images-"));
  const store = await import("../../src/main/message-image-store.ts");
  const invalid = path.join(imageHost.root, "text.png");
  await writeFile(invalid, "not an image");
  assert.equal((await store.messageImageResponse(messageImageUrl(invalid, "", "reply"))).status, 404);
  assert.equal((await store.messageImageResponse(messageImageUrl("/etc/passwd", "", "reply"))).status, 404);
  await assert.rejects(store.preserveMessageImage("https://example.com/shot.png", "", "reply"), /Invalid image reference/);
  const good = path.join(imageHost.root, "good.png");
  await writeFile(good, Buffer.from([137, 80, 78, 71]));
  await store.preserveMessageImages([invalid, good], "", "reply");
  assert.equal((await store.messageImageResponse(messageImageUrl(good, "", "reply"))).status, 200);
});
