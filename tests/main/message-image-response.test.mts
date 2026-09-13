import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { ComputerQuery } from "../../src/contracts/computers.ts";
import { messageImageUrl } from "../../src/domain/message-artifacts.ts";
import { MAX_IMAGE_BYTES } from "../../src/main/image-files.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

test("remote previews retain one original for concurrent reads, the viewer, and reopening offline", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-image-response-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const store = await import("../../src/main/message-image-store.ts");
  const { messageImageResponse } = await import("../../src/main/message-image-response.ts");
  const configuration = { directory: path.join(folder, "store"), thumbnail: () => Buffer.from("preview") };
  store.useMessageImageStore(configuration);
  const state = workspace({ threads: [task("local")] });
  state.computers.paired = [{ id: "holder", name: "Linux", host: "linux", pairedAt: 1, status: "connected", error: null, state: workspace({ threads: [task("remote")] }) }];
  const bytes = Buffer.from([255, 216, 255, 1]);
  const file = path.join(folder, "shot with spaces %.jpg");
  await writeFile(file, "different local image");
  const queries: unknown[] = [];
  const host = {
    state: () => state,
    query: async (id: string, query: ComputerQuery) => {
      queries.push([id, query]);
      return { data: bytes.toString("base64"), contentType: "image/jpeg" };
    },
  };
  const source = messageImageUrl(file, "/linux", "reply", false, "remote");
  const thumbnail = messageImageUrl(file, "/linux", "reply", true, "remote");
  // The selected thread is local; the URL must still address the remote holder.
  state.computers.active = null;
  const [preview, full] = await Promise.all([messageImageResponse(thumbnail, host), messageImageResponse(source, host)]);
  assert.equal(await preview.text(), "preview");
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(full.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  assert.deepEqual(queries, [["holder", { kind: "message-image", path: file, root: "/linux", message: "reply" }]]);
  // The download path also resolves the retained original without reading the remote path locally.
  assert.deepEqual(await readFile(await store.preserveMessageImage(file, "/linux", "reply")), bytes);
  await rm(file);
  vi.resetModules();
  (await import("../../src/main/message-image-store.ts")).useMessageImageStore(configuration);
  const reopened = (await import("../../src/main/message-image-response.ts")).messageImageResponse;
  host.query = async () => { throw new Error("Offline"); };
  state.computers.paired[0]!.status = "offline";
  assert.deepEqual(Buffer.from(await (await reopened(source, host)).arrayBuffer()), bytes);
  assert.equal(await (await reopened(thumbnail, host)).text(), "preview");
  assert.equal((await reopened(messageImageUrl(file, "/linux", "later", false, "remote"), host)).status, 404);
});

test("local images keep their route and remote failures never read the local source", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-image-response-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  (await import("../../src/main/message-image-store.ts")).useMessageImageStore({ directory: path.join(folder, "store"), thumbnail: () => null });
  const { messageImageResponse } = await import("../../src/main/message-image-response.ts");
  const state = workspace({ threads: [task("local")] });
  state.computers.paired = [{ id: "holder", name: "Linux", host: "linux", pairedAt: 1, status: "connected", error: null, state: workspace({ threads: [task("remote")] }) }];
  state.computers.active = "holder";
  const file = path.join(folder, "shot.png");
  await writeFile(file, "local image");
  let calls = 0;
  const host = { state: () => state, query: async (): Promise<unknown> => { calls++; throw new Error("Offline"); } };
  assert.equal(await (await messageImageResponse(messageImageUrl(file, "", "local-reply", false, "local"), host)).text(), "local image");
  assert.equal(await (await messageImageResponse(messageImageUrl(file, "", "legacy"), host)).text(), "local image");
  assert.equal(calls, 0);
  const source = messageImageUrl(file, "", "remote-reply", false, "remote");
  assert.equal((await messageImageResponse(source, host)).status, 404);
  assert.equal(calls, 1);
  assert.equal((await messageImageResponse(messageImageUrl("https://host/shot.png", "", "reply", false, "remote"), host)).status, 404);
  assert.equal(calls, 1);
  for (const result of [null, {}, { data: "", contentType: "image/png" }, { data: "!!!!", contentType: "image/png" },
    { data: "YQ==", contentType: "text/html" }, { data: "YQ==", contentType: "image/jpeg" },
    { data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"), contentType: "image/png" },
    { data: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4), contentType: "image/png" },
  ]) {
    assert.equal((await messageImageResponse(source, { ...host, query: async () => result })).status, 404);
  }
  // A failed transfer leaves no cache entry that would prevent a retry.
  const recovered = await messageImageResponse(source, { ...host, query: async () => ({ data: "YQ==", contentType: "image/png" }) });
  assert.equal(await recovered.text(), "a");
});
