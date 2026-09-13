import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isComputerClientMessage, isComputerQuery, isComputerTransfer, type ComputerQuery } from "../../src/contracts/computers.ts";
import { answerComputerQuery, type ComputerQueryHost } from "../../src/main/computer-queries.ts";
import { MAX_IMAGE_BYTES } from "../../src/main/image-files.ts";
import { useMessageImageStore } from "../../src/main/message-image-store.ts";

const host: ComputerQueryHost = {
  workspaces: () => { throw new Error("Images do not need a checkout."); },
  commands: async () => { throw new Error("Images do not need an engine."); },
};

test("message image queries validate the local reference bounds and use transfer deadlines", async () => {
  const query = { kind: "message-image", path: "/tmp/shot.png", root: "", message: "reply" } as const;
  for (const thumbnail of [undefined, false, true]) {
    const request = { kind: "query", requestId: "request", query: { ...query, thumbnail } } as const;
    assert.equal(isComputerClientMessage(request), true);
    assert.equal(isComputerTransfer(request), true);
  }
  assert.equal(isComputerQuery({ ...query, path: "a".repeat(4092) + ".png", root: "r".repeat(4096), message: "m".repeat(256) }), true);
  for (const fields of [
    { path: "a".repeat(4093) + ".png" }, { path: "/etc/passwd" }, { path: "https://host/image.png" },
    { path: "file:///tmp/shot.png" }, { path: null }, { path: "" },
    { root: null }, { root: "r".repeat(4097) }, { message: "" }, { message: "m".repeat(257) },
    { message: 1 }, { thumbnail: "1" }, { thumbnail: null },
  ]) {
    const invalid = { ...query, ...fields };
    assert.equal(isComputerQuery(invalid), false);
    await assert.rejects(answerComputerQuery(invalid as ComputerQuery, host));
  }
});

test("the holder preserves originals and answers bounded full-size and thumbnail reads, including headless hosts", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-image-query-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useMessageImageStore({ directory: path.join(folder, "store"), thumbnail: () => Buffer.from("preview") });
  const file = path.join(folder, "shot.jpg");
  const bytes = Buffer.from([255, 216, 255, 1]);
  await writeFile(file, bytes);
  const query = { kind: "message-image", path: "shot.jpg", root: folder, message: "reply" } as const;
  const original = { data: bytes.toString("base64"), contentType: "image/jpeg" };
  assert.deepEqual(await answerComputerQuery(query, host), original);
  await rm(file);
  assert.deepEqual(await answerComputerQuery(query, host), original);
  assert.deepEqual(await answerComputerQuery({ ...query, thumbnail: true }, host), { data: Buffer.from("preview").toString("base64"), contentType: "image/png" });
  await assert.rejects(answerComputerQuery({ ...query, message: "later" }, host));

  useMessageImageStore({ directory: path.join(folder, "headless"), thumbnail: () => null });
  await writeFile(file, bytes);
  assert.deepEqual(await answerComputerQuery({ ...query, thumbnail: true }, host), original);
  await writeFile(file, "");
  await assert.rejects(answerComputerQuery({ ...query, message: "empty" }, host), /too large or unavailable/);
  await truncate(file, MAX_IMAGE_BYTES + 1);
  await assert.rejects(answerComputerQuery({ ...query, message: "large" }, host), /too large or unavailable/);
});
