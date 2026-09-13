import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { attachmentName, attachmentUrl } from "../../src/application/attachments.ts";
import { isComputerQuery } from "../../src/contracts/computers.ts";
import { answerComputerQuery, type ComputerQueryHost } from "../../src/main/computer-queries.ts";
import { attachmentResponse } from "../../src/main/attachment-response.ts";
import { attachmentsDirectory, useAttachmentsDirectory, writeAttachment } from "../../src/main/attachment-store.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

const host: ComputerQueryHost = {
  workspaces: () => { throw new Error("An attachment does not need a checkout."); },
  commands: async () => { throw new Error("An attachment does not need an engine."); },
};

test("attachment queries return the holder's saved bytes and reject arbitrary paths and missing files", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-attachment-query-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useAttachmentsDirectory(folder);
  const saved = await writeAttachment("AQID");
  const name = attachmentName(saved);
  assert.equal(isComputerQuery({ kind: "attachment", name }), true);
  assert.equal(await answerComputerQuery({ kind: "attachment", name }, host), "AQID");
  await writeFile(path.join(folder, "outside.png"), "private");
  for (const invalid of ["../outside.png", "..\\outside.png", saved, "shot.png.context.json", "", "%2e%2e%2foutside.png"]) {
    assert.equal(isComputerQuery({ kind: "attachment", name: invalid }), false, invalid);
    await assert.rejects(answerComputerQuery({ kind: "attachment", name: invalid }, host), /Invalid attachment name/);
  }
  await assert.rejects(answerComputerQuery({ kind: "attachment", name: "missing.png" }, host), /ENOENT/);

  const state = workspace();
  const queries: unknown[] = [];
  const localReads: string[] = [];
  const responseHost = {
    state: () => state,
    query: async (id: string, query: Parameters<typeof answerComputerQuery>[0]) => {
      queries.push([id, query]);
      return answerComputerQuery(query, host);
    },
    fetch: async (url: string) => { localReads.push(url); return new Response("local"); },
  };
  state.computers.paired = [{ id: "holder", name: "Linux", host: "linux", pairedAt: 1, status: "connected", error: null, state: workspace({ threads: [task("remote")] }) }];
  // A local thread can be selected while the remote image viewer remains open.
  state.computers.active = null;
  const response = await attachmentResponse(attachmentUrl(`/linux/attachments/${name}`, "remote"), responseHost);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
  assert.deepEqual(queries, [["holder", { kind: "attachment", name }]]);
  assert.deepEqual(localReads, []);
  assert.equal(await (await attachmentResponse(attachmentUrl(saved, "local"), responseHost)).text(), "local");
  assert.equal(localReads[0], new URL(`file://${attachmentsDirectory()}/${name}`).href);
  assert.equal((await attachmentResponse("attachment://file/..%2foutside.png?taskId=remote", responseHost)).status, 404);
  assert.equal(queries.length, 1);
  assert.equal((await attachmentResponse(attachmentUrl(saved, "remote"), { ...responseHost, query: async () => { throw new Error("Offline"); } })).status, 404);
  assert.equal(localReads.length, 1, "an offline holder never falls back to a local image of the same name");
});
