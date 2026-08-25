import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, describe } from "vitest";
import { promisify } from "node:util";
import {
  commentQuote,
  diffRows,
  fileFingerprint,
  hunkText,
  hunkTextIndex,
  isDiffRange,
  languageForPath,
  parseFilePatch,
  rangeKey,
  splitRows,
  type DiffFileSummary,
} from "../../../src/domain/diff.ts";
import { diffPatch, diffSummary, readNumstat } from "../../../src/main/workspace/git-diff.mts";
import { UnknownWorkspaceError } from "../../../src/main/workspace/workspace-service.mts";
import type { WorkspaceResolution } from "../../../src/domain/workspace.ts";

const execFileAsync = promisify(execFile);

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@ export function app()",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 22;",
  "+const third = 3;",
  " const last = 4;",
  "",
].join("\n");

async function git(root: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-diff-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

function workspaces(root: string) {
  return { resolve: async (): Promise<WorkspaceResolution> => ({ status: "available", workspace: { id: "fixture", kind: "project", root } }) };
}

function assertAvailable<T extends { status: string }>(result: T): asserts result is Extract<T, { status: "available" }> {
  assert.equal(result.status, "available");
}

describe("Diff patches", { concurrent: true }, () => {

test("a patch parses into hunks that keep both sides' line numbers", () => {
  const file = parseFilePatch(PATCH, "fallback.ts");
  assert.equal(file.path, "src/app.ts");
  assert.equal(file.hunks.length, 1);
  const [hunk] = file.hunks;
  assert.equal(hunk.header, "export function app()");
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [1, 4, 1, 5]);
  assert.deepEqual(hunk.rows.map((row) => [row.kind, row.oldLine, row.newLine]), [
    ["context", 1, 1],
    ["delete", 2, null],
    ["add", null, 2],
    ["add", null, 3],
    ["context", 3, 4],
  ]);
});

test("a patch with no headers of its own is named by the file that was asked for", () => {
  const file = parseFilePatch("@@ -1 +1 @@\n-a\n+b\n", "notes.md");
  assert.equal(file.path, "notes.md");
});

test("a rename keeps the path it came from", () => {
  const renamed = ["--- a/old/name.ts", "+++ b/new/name.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
  const file = parseFilePatch(renamed, "new/name.ts");
  assert.equal(file.path, "new/name.ts");
  assert.equal(file.previousPath, "old/name.ts");
});

test("the missing-newline marker annotates rather than adding a line", () => {
  const file = parseFilePatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n", "a.txt");
  assert.deepEqual(file.hunks[0].rows.map((row) => row.text), ["a", "b"]);
});
});

describe("Diff rows", { concurrent: true }, () => {

test("rows are drawn flat, with each hunk headed by one of its own", () => {
  const rows = diffRows(parseFilePatch(PATCH, "src/app.ts"));
  assert.equal(rows[0].kind, "hunk");
  assert.equal(rows[0].text, "@@ -1,4 +1,5 @@ export function app()");
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test("each side of a hunk reads as the text it was cut from", () => {
  const [hunk] = parseFilePatch(PATCH, "src/app.ts").hunks;
  assert.equal(hunkText(hunk, "old"), "const first = 1;\nconst second = 2;\nconst last = 4;");
  assert.equal(hunkText(hunk, "new"), "const first = 1;\nconst second = 22;\nconst third = 3;\nconst last = 4;");
});

test("a hunk's rows index into the side they are drawn from", () => {
  const [hunk] = parseFilePatch(PATCH, "src/app.ts").hunks;
  const added = hunk.rows.find((row) => row.text === "const third = 3;");
  assert.ok(added);
  assert.equal(hunkTextIndex(hunk, "new").get(added.key), 2);
  assert.equal(hunkTextIndex(hunk, "old").has(added.key), false);
});

test("a comment names the file and the lines, and keeps the markers", () => {
  const rows = diffRows(parseFilePatch(PATCH, "src/app.ts"));
  const quote = commentQuote("src/app.ts", rows.slice(3, 5), "new");
  assert.equal(quote, ["src/app.ts:L2-L3", "+const second = 22;", "+const third = 3;"].join("\n"));
});

test("a comment on one line names that line alone", () => {
  const rows = diffRows(parseFilePatch(PATCH, "src/app.ts"));
  assert.match(commentQuote("src/app.ts", rows.slice(1, 2), "new"), /^src\/app\.ts:L1\n/);
});

test("deletions and the additions replacing them are paired across the two columns", () => {
  const pairs = splitRows(parseFilePatch(PATCH, "src/app.ts")).filter((row) => row.kind === "pair");
  assert.deepEqual(pairs.map((pair) => [pair.left?.kind ?? null, pair.right?.kind ?? null]), [
    ["context", "context"],
    ["delete", "add"],
    [null, "add"],
    ["context", "context"],
  ]);
});

test("both views key their rows the same way, so both find the same tokens", () => {
  const file = parseFilePatch(PATCH, "src/app.ts");
  const unified = new Set(diffRows(file).map((row) => row.key));
  const pairs = splitRows(file).filter((row) => row.kind === "pair");
  const sides = pairs.flatMap((pair) => [pair.left, pair.right]).filter((row) => row !== null);

  assert.ok(sides.length > 0);
  for (const row of sides) assert.ok(unified.has(row.key), `${row.key} is not a key the one-column view uses`);
});
});

describe("Diff values", { concurrent: true }, () => {

test("a grammar is chosen by extension, and an unreadable one asks for none", () => {
  assert.equal(languageForPath("src/app.tsx"), "tsx");
  assert.equal(languageForPath("deep/path/run.mts"), "typescript");
  assert.equal(languageForPath("Makefile"), null);
  assert.equal(languageForPath("archive.tar.gz"), null);
});

test("a comparison reduces to a key that tells one from another", () => {
  assert.equal(rangeKey({ kind: "uncommitted" }), "uncommitted");
  assert.notEqual(
    rangeKey({ kind: "branches", base: "main", compare: null }),
    rangeKey({ kind: "branches", base: "main", compare: "topic" }),
  );
});

test("only a well-formed comparison crosses the process boundary", () => {
  assert.equal(isDiffRange({ kind: "uncommitted" }), true);
  assert.equal(isDiffRange({ kind: "branches", base: "main", compare: null }), true);
  assert.equal(isDiffRange({ kind: "branches", base: "", compare: null }), false);
  assert.equal(isDiffRange({ kind: "branches", compare: "topic" }), false);
  assert.equal(isDiffRange("uncommitted"), false);
  assert.equal(isDiffRange(null), false);
});

test("a file's fingerprint moves when its counts do", () => {
  const file = { path: "a.ts", status: "modified", additions: 2, deletions: 1, binary: false } satisfies DiffFileSummary;
  assert.equal(fileFingerprint(file), fileFingerprint({ ...file }));
  assert.notEqual(fileFingerprint(file), fileFingerprint({ ...file, additions: 3 }));
});
});

describe("Diff summaries", { concurrent: true }, () => {

test("a summary distinguishes unknown workspaces", async () => {
  const result = await diffSummary("missing", { kind: "uncommitted" }, {
    resolve: async () => { throw new UnknownWorkspaceError("missing"); },
  });
  assert.deepEqual(result, { status: "unknown", workspaceId: "missing" });
});

test("a summary lists what is uncommitted, tracked and not", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "fresh.txt"), "new\n");

  const result = await diffSummary("fixture", { kind: "uncommitted" }, workspaces(root));
  assertAvailable(result);
  assert.deepEqual(result.files.map((file) => [file.path, file.status, file.additions]), [
    ["fresh.txt", "untracked", 1],
    ["tracked.txt", "modified", 1],
  ]);
  assert.equal(result.additions, 2);
});

test("a summary names what a commit added and took away", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, "checkout", "-b", "topic");
  await writeFile(path.join(root, "added.txt"), "a\n");
  await rm(path.join(root, "tracked.txt"));
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "shuffle");

  const result = await diffSummary("fixture", { kind: "branches", base: "main", compare: "topic" }, workspaces(root));
  assertAvailable(result);
  assert.deepEqual(result.files.map((file) => [file.path, file.status]), [["added.txt", "added"], ["tracked.txt", "deleted"]]);
});

test("a branch comparison measures from where the two sides last agreed", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, "checkout", "-b", "topic");
  await writeFile(path.join(root, "mine.txt"), "mine\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "mine");
  await git(root, "checkout", "main");
  await writeFile(path.join(root, "theirs.txt"), "theirs\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "theirs");

  const result = await diffSummary("fixture", { kind: "branches", base: "main", compare: "topic" }, workspaces(root));
  assertAvailable(result);
  /** The base's own commit is not the thread's work, so it stays out of the list. */
  assert.deepEqual(result.files.map((file) => file.path), ["mine.txt"]);
});

test("a repository with no commits lists what it holds instead of failing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-diff-empty-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
  await writeFile(path.join(root, "first.txt"), "one\ntwo\n");

  const result = await diffSummary("fixture", { kind: "uncommitted" }, workspaces(root));
  assertAvailable(result);
  assert.deepEqual(result.files.map((file) => [file.path, file.additions]), [["first.txt", 2]]);

  const patch = await diffPatch("fixture", { kind: "uncommitted" }, "first.txt", workspaces(root));
  assertAvailable(patch);
  assert.deepEqual(parseFilePatch(patch.patch, "first.txt").hunks[0].rows.map((row) => row.text), ["one", "two"]);
});

test("a file whose name holds a tab is still one file", () => {
  const files = readNumstat("2\t1\ttabbed\tname.txt\0", new Map());
  assert.deepEqual(files.map((file) => [file.path, file.additions, file.deletions]), [["tabbed\tname.txt", 2, 1]]);
});
});

describe("Diff patches from a repository", { concurrent: true }, () => {

test("a patch is read for one file, and an untracked one is diffed against emptiness", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tracked.txt"), "one\nTWO\n");
  await writeFile(path.join(root, "fresh.txt"), "brand\nnew\n");

  const tracked = await diffPatch("fixture", { kind: "uncommitted" }, "tracked.txt", workspaces(root));
  assertAvailable(tracked);
  assert.deepEqual(parseFilePatch(tracked.patch, "tracked.txt").hunks[0].rows.map((row) => row.kind), ["context", "delete", "add"]);

  const fresh = await diffPatch("fixture", { kind: "uncommitted" }, "fresh.txt", workspaces(root));
  assertAvailable(fresh);
  assert.deepEqual(parseFilePatch(fresh.patch, "fresh.txt").hunks[0].rows.map((row) => row.text), ["brand", "new"]);
});

test("a path is a path, not a glob, however it is spelt", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tracked.txt"), "one\nTWO\n");

  /** Without literal pathspecs this would match `tracked.txt` and report another file's changes. */
  const result = await diffPatch("fixture", { kind: "uncommitted" }, "tr*.txt", workspaces(root));
  assertAvailable(result);
  assert.equal(result.patch.trim(), "", "nothing is named by that path");
});

test("a rename's patch shows what changed, not the whole file over again", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, "mv", "tracked.txt", "moved.txt");
  await writeFile(path.join(root, "moved.txt"), "one\ntwo\nthree\n");

  const named = await diffPatch("fixture", { kind: "uncommitted" }, "moved.txt", workspaces(root), "tracked.txt");
  assertAvailable(named);
  const rows = parseFilePatch(named.patch, "moved.txt").hunks[0].rows;
  assert.deepEqual(rows.filter((row) => row.kind === "add").map((row) => row.text), ["three"]);
  assert.equal(rows.filter((row) => row.kind === "delete").length, 0, "the old path is not re-added");
});

test("a patch outside the workspace is refused rather than read", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = await diffPatch("fixture", { kind: "uncommitted" }, "../escape.txt", workspaces(root));
  assert.deepEqual(result, { status: "error", message: "Path is outside the workspace." });
});
});
