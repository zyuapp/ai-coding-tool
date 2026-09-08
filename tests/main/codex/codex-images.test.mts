import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { codexImageOutput } from "../../../src/main/codex/codex-images.mts";
import type { ImageGenerationItem } from "../../../src/main/codex/protocol/ImageGenerationItem.ts";
import { messageImages } from "../../../src/renderer/message-images.ts";

const host = { root: "" };

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const item = (overrides: Partial<ImageGenerationItem> = {}): ImageGenerationItem => ({
  id: "image-1", status: "completed", revisedPrompt: "Pixel art cat", result: "", failure: null, ...overrides,
});

beforeEach(async () => { host.root = await mkdtemp(path.join(os.tmpdir(), "codex-image-")); });
afterEach(async () => { await rm(host.root, { recursive: true, force: true }); });

test("the worker copies a native image with Node APIs before publishing its preview", async () => {
  const file = path.join(host.root, "cat [1] (100%) #1.png");
  await writeFile(file, png);
  const text = await codexImageOutput(item({ savedPath: file }), host.root, host.root);
  const saved = messageImages(text)[0]!;
  assert.equal(saved.label, "Generated image");
  assert.notEqual(saved.path, file);
  await rm(file);
  assert.deepEqual(await readFile(saved.path), png);
});

test("image data supplies a saved preview when Codex omits its path or the file is unavailable", async () => {
  for (const savedPath of [undefined, path.join(host.root, "missing.png")]) {
    const text = await codexImageOutput(item({ savedPath, result: png.toString("base64") }), host.root, host.root);
    const image = messageImages(text)[0]!;
    assert.deepEqual(await readFile(image.path), png);
  }
});

test("failed, cancelled and empty generations report what happened, and malformed image data is rejected", async () => {
  assert.match(await codexImageOutput(item({ failure: { type: "usageLimitExceeded", limitId: "imagegen", resetsAt: null } }), host.root, host.root), /usage limit/);
  assert.match(await codexImageOutput(item({ status: "failed" }), host.root, host.root), /generation failed/);
  assert.match(await codexImageOutput(item({ status: "cancelled" }), host.root, host.root), /cancelled/);
  assert.match(await codexImageOutput(item(), host.root, host.root), /without returning an image/);
  await assert.rejects(codexImageOutput(item({ result: "not base64" }), host.root, host.root));
});
