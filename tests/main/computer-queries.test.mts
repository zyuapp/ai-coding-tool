import { MAX_ATTACHMENT_BYTES } from "../../src/domain/conversation.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { attachmentName, attachmentUrl } from "../../src/application/attachments.ts";
import { isComputerQuery, type ComputerQuery } from "../../src/contracts/computers.ts";
import type { WorkspaceResolution } from "../../src/domain/workspace.ts";
import { answerComputerQuery, createComputerReads, type ComputerQueryHost, type ComputerReadHost, type ComputerReadOwner } from "../../src/main/computer-queries.ts";
import { attachmentResponse } from "../../src/main/attachment-response.ts";
import { useAttachmentsDirectory, writeAttachment, readSavedAttachment } from "../../src/main/attachment-store.ts";
import { useMessageImageStore } from "../../src/main/message-image-store.ts";
import type { WorkspaceService } from "../../src/main/workspace/workspace-service.mts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

const execFileAsync = promisify(execFile);

const host: ComputerQueryHost = {
  threads: async () => { throw new Error("An attachment does not need a thread."); },
  workspaces: () => { throw new Error("An attachment does not need a checkout."); },
};

type Link = ReturnType<ComputerReadHost["links"]>;

/** The thread "remote" and the checkouts "repo" and "gone" are held by the paired computer "holder". */
function heldElsewhere() {
  const state = workspace({ threads: [task("local")] });
  const paired = [{
    id: "holder", name: "Linux", host: "linux", pairedAt: 1, status: "connected" as const, error: null,
    state: workspace({ threads: [task("remote")], projects: [{ id: "repo", root: "/repo", workspaceId: "repo" }, { id: "gone", root: "/gone", workspaceId: "gone" }] }),
  }];
  return { ...state, computers: { ...state.computers, paired } };
}

function readsOver(link: Link, local: ComputerQueryHost = host) {
  return createComputerReads({ ...local, state: heldElsewhere, links: () => link });
}

function readsHere(local: ComputerQueryHost = host) {
  return createComputerReads({ ...local, state: () => workspace(), links: () => null });
}

test("paired thread queries validate bounded read-only inputs before reaching the runtime", async () => {
  const queries: unknown[] = [];
  const reader = { ...host, threads: async (query: Parameters<ComputerQueryHost["threads"]>[0]) => { queries.push(query); return "transcript"; } };
  assert.equal(await answerComputerQuery({ kind: "thread-read", threadId: "thread", limit: 30 }, reader), "transcript");
  assert.equal(await answerComputerQuery({ kind: "thread-list", project: "all", search: "needle", limit: 20 }, reader), "transcript");
  assert.equal(queries.length, 2);
  for (const query of [
    { kind: "thread-read", threadId: "", limit: 30 },
    { kind: "thread-read", threadId: "thread", limit: 201 },
    { kind: "thread-list", search: "a".repeat(1_001) },
    { kind: "thread-list", limit: -1 },
    { kind: "thread-list", limit: 0.5 },
    { kind: "thread-list", archived: "yes" },
  ]) assert.equal(isComputerQuery(query), false);
  await assert.rejects(answerComputerQuery({ kind: "thread-read", threadId: "thread", limit: 201 }, reader), /Invalid thread-read query/);
  assert.equal(queries.length, 2);
});

test("attachment reads return the holder's saved bytes and reject arbitrary paths and missing files", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-attachment-query-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useAttachmentsDirectory(folder);
  const saved = await writeAttachment("AQID");
  const name = attachmentName(saved);
  const here = readsHere();
  assert.equal(isComputerQuery({ kind: "attachment", name }), true);
  assert.equal(await here.answer({ kind: "attachment", name }), "AQID");
  await writeFile(path.join(folder, "outside.png"), "private");
  for (const invalid of ["../outside.png", "..\\outside.png", saved, "shot.png.context.json", "", "%2e%2e%2foutside.png"]) {
    assert.equal(isComputerQuery({ kind: "attachment", name: invalid }), false, invalid);
    await assert.rejects(here.answer({ kind: "attachment", name: invalid }), /Invalid attachment query/);
  }
  await assert.rejects(here.answer({ kind: "attachment", name: "missing.png" }), /ENOENT/);

  const queries: unknown[] = [];
  const reads = readsOver({ query: async (id, query) => { queries.push([id, query]); return here.answer(query); } });
  // A local thread can be selected while the remote image viewer remains open.
  const response = await attachmentResponse(attachmentUrl(`/linux/attachments/${name}`, "remote"), reads);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
  assert.deepEqual(queries, [["holder", { kind: "attachment", name }]]);
  const local = await attachmentResponse(attachmentUrl(saved, "local"), reads);
  assert.deepEqual(Buffer.from(await local.arrayBuffer()), Buffer.from([1, 2, 3]));
  assert.equal(queries.length, 1);
  assert.equal((await attachmentResponse("attachment://file/..%2foutside.png?taskId=remote", reads)).status, 404);
  assert.equal(queries.length, 1);
  const offline = readsOver({ query: async () => { throw new Error("Offline"); } });
  assert.equal((await attachmentResponse(attachmentUrl(saved, "remote"), offline)).status, 404, "an offline holder never falls back to a local image of the same name");
});

test("saving and reading an attachment use the decoded byte limit including base64 padding", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-attachment-limit-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useAttachmentsDirectory(folder);
  const data = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7).toString("base64");
  const saved = await writeAttachment(data);
  assert.equal(await readSavedAttachment(attachmentName(saved)), data);
  const response = await attachmentResponse(attachmentUrl(saved, "remote"), readsOver({ query: async () => data }));
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, MAX_ATTACHMENT_BYTES);
  await assert.rejects(writeAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")), /too large/);
});

test("directory reads share local and remote results, expand home and exclude files and unrequested hidden folders", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-directories-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await Promise.all(["work", "world", ".hidden"].map((name) => mkdir(path.join(folder, name))));
  await writeFile(path.join(folder, "word.txt"), "file");
  await symlink(path.join(folder, "work"), path.join(folder, "work-link"));
  await symlink(path.join(folder, "missing"), path.join(folder, "wrong-link"));
  const here = readsHere();
  const directories = (prefix: string, computer?: string) => here.read({ kind: "directories", prefix }, { computer });
  const prefix = `${folder}/wo`;
  const expected = ["work", "work-link", "world"].map((name) => `${folder}/${name}/`).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(await here.answer({ kind: "directories", prefix }), expected);
  assert.deepEqual(await directories(prefix, "this"), expected);
  const queries: unknown[] = [];
  const reads = readsOver({ query: async (id, query) => { queries.push([id, query]); return here.answer(query); } });
  assert.deepEqual(await reads.read({ kind: "directories", prefix }, { computer: "linux" }), expected);
  assert.deepEqual(queries, [["linux", { kind: "directories", prefix }]]);
  assert.deepEqual(await directories(`${folder}/.`), [`${folder}/.hidden/`]);
  assert.equal((await directories(`${folder}/`)).includes(`${folder}/.hidden/`), false);
  assert.deepEqual(await directories(`${folder}/missing/`), []);
  assert.deepEqual(await directories(`${folder}/word.txt/`), []);
  assert.deepEqual(await directories("relative/path"), []);
  assert.deepEqual(await directories("~/"), await directories(`${os.homedir()}/`));
  assert.deepEqual(await directories("~"), await directories(`${os.homedir()}/`));
});

test("directory scans and untrusted queries and answers are bounded", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-directory-limit-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 30 }, (_, i) => mkdir(path.join(folder, `dir-${i}`))));
  const here = readsHere();
  const over = (link: Link) => readsOver(link).read({ kind: "directories", prefix: "/" }, { computer: "linux" });
  assert.equal((await here.read({ kind: "directories", prefix: `${folder}/` }, { computer: undefined })).length, 20);
  for (const prefix of [42, "x".repeat(4097), "bad\0path"]) assert.equal(isComputerQuery({ kind: "directories", prefix }), false);
  await assert.rejects(here.read({ kind: "directories", prefix: "bad\0path" }, { computer: undefined }), /Invalid directories query/);
  await assert.rejects(here.read({ kind: "directories", prefix: "/" }, { computer: "linux" }), /unavailable/);
  await assert.rejects(over({ query: async () => { throw new Error("Connection refused"); } }), /Connection refused/);
  await assert.rejects(over({ query: async () => Array(21).fill("/") }), /Invalid directory response/);
  await assert.rejects(over({ query: async () => [42] }), /Invalid directory response/);
});

async function repository(root: string) {
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });
  await git("init", "-b", "main");
  await git("config", "user.email", "tests@example.com");
  await git("config", "user.name", "AI Coding Tool Tests");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await git("add", "tracked.txt");
  await git("commit", "-m", "initial");
  await git("branch", "feature");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
}

/** `settles` reads answer every failure as a result; the rest reject. `fresh` empties what a forwarded read keeps. */
type Row = { query: ComputerQuery; owner: ComputerReadOwner; settles: boolean; fresh?: () => void };

test("every read answers in one shape from this computer, over a link, and when the link drops", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-reads-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const checkout = path.join(folder, "checkout");
  await mkdir(checkout);
  await repository(checkout);
  await mkdir(path.join(folder, "docs"));
  useAttachmentsDirectory(folder);
  const attachment = attachmentName(await writeAttachment("AQID"));
  let stores = 0;
  const freshStore = () => useMessageImageStore({ directory: path.join(folder, `images-${stores++}`), thumbnail: () => Buffer.from("preview") });
  freshStore();
  await writeFile(path.join(folder, "shot.jpg"), Buffer.from([255, 216, 255, 1]));
  const local: ComputerQueryHost = {
    threads: async (query) => ({ answered: query }),
    workspaces: () => ({
      resolve: async (id: string): Promise<WorkspaceResolution> => id === "repo"
        ? { status: "available", workspace: { id, kind: "project", root: checkout } }
        : { status: "unavailable", workspace: { id, kind: "project", root: "/gone" }, reason: "missing" },
    }) as unknown as WorkspaceService,
  };
  const image = { kind: "message-image", path: "shot.jpg", root: folder, message: "reply" } as const;
  const rows: Row[] = [
    { query: { kind: "thread-read", threadId: "remote", limit: 5 }, owner: { thread: "remote" }, settles: false },
    { query: { kind: "thread-list", search: "needle" }, owner: { computer: "holder" }, settles: false },
    { query: { kind: "terminal-output", terminalId: "no-such-terminal" }, owner: { computer: "holder" }, settles: false },
    { query: { kind: "directories", prefix: `${folder}/do` }, owner: { computer: "holder" }, settles: false },
    { query: { kind: "attachment", name: attachment }, owner: { thread: "remote" }, settles: false },
    { query: image, owner: { thread: "remote" }, settles: false, fresh: freshStore },
    { query: { ...image, thumbnail: true }, owner: { thread: "remote" }, settles: false, fresh: freshStore },
    { query: { kind: "branches", workspaceId: "repo" }, owner: { workspace: "repo" }, settles: true },
    { query: { kind: "branches", workspaceId: "gone" }, owner: { workspace: "gone" }, settles: true },
    { query: { kind: "diff-patch", workspaceId: "repo", range: { kind: "uncommitted" }, path: "tracked.txt" }, owner: { workspace: "repo" }, settles: true },
    { query: { kind: "commands", workspaceId: "gone", engine: "claude" }, owner: { workspace: "gone" }, settles: true },
  ];
  for (const row of rows) {
    const label = JSON.stringify(row.query);
    const here = readsHere(local);
    /** What the holder sends, taken before the asking side reads so the two never share a copy in flight. */
    const sent = new Map<string, unknown>();
    for (const query of [row.query, ...(row.query.kind === "message-image" ? [image] : [])]) sent.set(JSON.stringify(query), JSON.parse(JSON.stringify(await here.answer(query))));
    const answered = await here.read(row.query, "computer" in row.owner ? { computer: "this" } : row.owner);
    if (row.settles) assert.equal((answered as { status: string }).status, label.includes("gone") ? "error" : "available", label);

    row.fresh?.();
    const asked: unknown[] = [];
    const linked = readsOver({ query: async (id, query) => { asked.push(id); return sent.get(JSON.stringify(query)); } }, local);
    assert.deepEqual(await linked.read(row.query, row.owner), answered, label);
    assert.deepEqual(asked, ["holder"], label);

    row.fresh?.();
    const dropped = readsOver({ query: async () => { throw new Error("The line dropped."); } }, local);
    if (row.settles) assert.deepEqual(await dropped.read(row.query, row.owner), { status: "error", message: "The line dropped." }, label);
    else await assert.rejects(dropped.read(row.query, row.owner), /The line dropped/, label);

    if (row.query.kind === "thread-read" || row.query.kind === "thread-list") continue;
    row.fresh?.();
    const malformed = readsOver({ query: async () => ({ status: "available", unexpected: true }) }, local);
    if (row.settles) assert.match((await malformed.read(row.query, row.owner) as { message?: string }).message ?? "", /Invalid \w+ response/, label);
    else await assert.rejects(malformed.read(row.query, row.owner), /Invalid/, label);
  }
  const unlinked = createComputerReads({ ...local, state: heldElsewhere, links: () => null });
  assert.deepEqual(await unlinked.read({ kind: "branches", workspaceId: "repo" }, { workspace: "repo" }), { status: "error", message: "That computer is unavailable." });
  assert.deepEqual(await unlinked.read({ kind: "branches", workspaceId: "" }, { workspace: "" }), { status: "error", message: "Invalid branches query." });
});
