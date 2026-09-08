import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { codexImageOutput } from "../../../src/main/codex/codex-images.mts";
import type { ImageGenerationItem } from "../../../src/main/codex/protocol/ImageGenerationItem.ts";
import { messageImageUrl } from "../../../src/domain/message-artifacts.ts";
import { messageImages } from "../../../src/renderer/message-images.ts";

const host = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => host.root },
  nativeImage: { createFromBuffer: (bytes: Buffer) => ({
    isEmpty: () => bytes[0] !== 137,
    getSize: () => ({ width: 1024, height: 1024 }),
    resize: () => ({ toPNG: () => Buffer.from("thumbnail") }),
  }) },
}));

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const item = (overrides: Partial<ImageGenerationItem> = {}): ImageGenerationItem => ({
  id: "image-1", status: "completed", revisedPrompt: "Pixel art cat", result: "", failure: null, ...overrides,
});

beforeEach(async () => { host.root = await mkdtemp(path.join(os.tmpdir(), "codex-image-")); });
afterEach(async () => { await rm(host.root, { recursive: true, force: true }); });

test("a native image is preserved before its preview is published and survives a restart", async () => {
  const file = path.join(host.root, "cat [1] (100%) #1.png");
  await writeFile(file, png);
  const text = await codexImageOutput(item({ savedPath: file }), host.root);
  assert.deepEqual(messageImages(text), [{ path: file, label: "Generated image" }]);
  await rm(file);
  vi.resetModules();
  const { messageImageResponse } = await import("../../../src/main/message-image-store.ts");
  const response = await messageImageResponse(messageImageUrl(file, host.root, "image-1"));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test("image data supplies a saved preview when Codex omits its path or the file is unavailable", async () => {
  for (const savedPath of [undefined, path.join(host.root, "missing.png")]) {
    const text = await codexImageOutput(item({ savedPath, result: png.toString("base64") }), host.root);
    const image = messageImages(text)[0]!;
    assert.deepEqual(await readFile(image.path), png);
    const { messageImageResponse } = await import("../../../src/main/message-image-store.ts");
    assert.equal((await messageImageResponse(messageImageUrl(image.path, host.root, "image-1", true))).status, 200);
  }
});

test("failed, cancelled and empty generations report what happened, and malformed image data is rejected", async () => {
  assert.match(await codexImageOutput(item({ failure: { type: "usageLimitExceeded", limitId: "imagegen", resetsAt: null } }), host.root), /usage limit/);
  assert.match(await codexImageOutput(item({ status: "failed" }), host.root), /generation failed/);
  assert.match(await codexImageOutput(item({ status: "cancelled" }), host.root), /cancelled/);
  assert.match(await codexImageOutput(item(), host.root), /without returning an image/);
  await assert.rejects(codexImageOutput(item({ result: "not base64" }), host.root));
});
