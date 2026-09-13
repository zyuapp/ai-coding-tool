import { MAX_ATTACHMENT_BYTES } from "../../src/domain/conversation.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { attachmentName, attachmentUrl } from "../../src/application/attachments.ts";
import { isComputerQuery } from "../../src/contracts/computers.ts";
import { answerComputerQuery, queryDirectories, type ComputerQueryHost } from "../../src/main/computer-queries.ts";
import { attachmentResponse } from "../../src/main/attachment-response.ts";
import { attachmentsDirectory, useAttachmentsDirectory, writeAttachment, readSavedAttachment } from "../../src/main/attachment-store.ts";
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


test("saving and reading an attachment use the decoded byte limit including base64 padding", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-attachment-limit-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useAttachmentsDirectory(folder);
  const data = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7).toString("base64");
  const saved = await writeAttachment(data);
  assert.equal(await readSavedAttachment(attachmentName(saved)), data);
  const state = workspace();
  state.computers.paired = [{ id: "holder", name: "Linux", host: "linux", pairedAt: 1, status: "connected", error: null, state: workspace({ threads: [task("remote")] }) }];
  const response = await attachmentResponse(attachmentUrl(saved, "remote"), {
    state: () => state, query: async () => data, fetch: async () => { throw new Error("Expected remote read"); },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, MAX_ATTACHMENT_BYTES);
  await assert.rejects(writeAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")), /too large/);
});


test("directory queries share local and remote results, expand home and exclude files and unrequested hidden folders", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-directories-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await Promise.all(["work", "world", ".hidden"].map((name) => mkdir(path.join(folder, name))));
  await writeFile(path.join(folder, "word.txt"), "file");
  await symlink(path.join(folder, "work"), path.join(folder, "work-link"));
  await symlink(path.join(folder, "missing"), path.join(folder, "wrong-link"));
  const prefix = `${folder}/wo`;
  const expected = ["work", "work-link", "world"].map((name) => `${folder}/${name}/`).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(await answerComputerQuery({ kind: "directories", prefix }, host), expected);
  assert.deepEqual(await queryDirectories(prefix, "this"), expected);
  const queries: unknown[] = [];
  assert.deepEqual(await queryDirectories(prefix, "linux", async (id, query) => {
    queries.push([id, query]);
    return answerComputerQuery(query, host);
  }), expected);
  assert.deepEqual(queries, [["linux", { kind: "directories", prefix }]]);
  assert.deepEqual(await queryDirectories(`${folder}/.`), [`${folder}/.hidden/`]);
  assert.equal((await queryDirectories(`${folder}/`)).includes(`${folder}/.hidden/`), false);
  assert.deepEqual(await queryDirectories(`${folder}/missing/`), []);
  assert.deepEqual(await queryDirectories(`${folder}/word.txt/`), []);
  assert.deepEqual(await queryDirectories("relative/path"), []);
  assert.deepEqual(await queryDirectories("~/"), await queryDirectories(`${os.homedir()}/`));
  assert.deepEqual(await queryDirectories("~"), await queryDirectories(`${os.homedir()}/`));
});

test("directory scans and untrusted queries and answers are bounded", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-directory-limit-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 30 }, (_, i) => mkdir(path.join(folder, `dir-${i}`))));
  assert.equal((await queryDirectories(`${folder}/`)).length, 20);
  for (const prefix of [42, "x".repeat(4097), "bad\0path"]) assert.equal(isComputerQuery({ kind: "directories", prefix }), false);
  await assert.rejects(queryDirectories("bad\0path"), /Invalid directory query/);
  await assert.rejects(queryDirectories("/", "linux"), /unavailable/);
  await assert.rejects(queryDirectories("/", "linux", async () => { throw new Error("Connection refused"); }), /Connection refused/);
  await assert.rejects(queryDirectories("/", "linux", async () => Array(21).fill("/")), /Invalid directory response/);
  await assert.rejects(queryDirectories("/", "linux", async () => [42]), /Invalid directory response/);
});
