import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "vitest";
import { COMMIT_PAGE_SIZE, isCommitHistoryRequest, type CommitHistoryResult } from "../../../src/domain/commit-history.ts";
import { commitHistory } from "../../../src/main/workspace/git-commits.mts";
import { git } from "../../../src/main/workspace/git.mts";

async function repository(t: TestContext, count = 2416) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-commit-history-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  if (!count) return root;
  const records = Array.from({ length: count }, (_, index) => {
    const subject = index === 73 ? "Fix [cache].* for café" : index === 101 ? "Handle --all as text" : `Change ${index + 1}`;
    return `commit refs/heads/main\nmark :${index + 1}\ncommitter Test Author <tests@example.com> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n${index ? `from :${index}\n` : ""}\n`;
  }).join("");
  await git(root, ["fast-import", "--quiet"], records);
  return root;
}

function available(result: CommitHistoryResult) {
  if (result.status !== "available") assert.fail(result.message);
  return result;
}

test("history pages stay bounded and keep their snapshot while HEAD advances", async (t) => {
  const root = await repository(t);
  const first = available(await commitHistory(root, { query: "", offset: 0 }));
  assert.equal(first.commits.length, COMMIT_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].subject, "Change 2416");
  assert.equal(first.commits[0].author, "Test Author");
  assert.match(first.commits[0].committedAt, /^2023-/);
  assert.ok(first.head);

  await git(root, ["-c", "user.name=Test Author", "-c", "user.email=tests@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "New agent commit"]);
  const next = available(await commitHistory(root, { query: "", head: first.head, offset: COMMIT_PAGE_SIZE }));
  assert.equal(next.head, first.head);
  assert.equal(next.commits[0].subject, "Change 2316");
  assert.ok(next.commits.every((commit) => !first.commits.some((old) => old.sha === commit.sha)));
  const last = available(await commitHistory(root, { query: "", head: first.head, offset: 2400 }));
  assert.equal(last.commits.length, 16);
  assert.equal(last.hasMore, false);
  assert.equal(last.commits.at(-1)?.subject, "Change 1");
  assert.equal(available(await commitHistory(root, { query: "", offset: 0 })).commits[0].subject, "New agent commit");
});

test("search reaches old commits by literal message or SHA and paginates the matching history", async (t) => {
  const root = await repository(t);
  const literal = available(await commitHistory(root, { query: "[CACHE].*", offset: 0 }));
  assert.equal(literal.commits.length, 1);
  assert.equal(literal.commits[0].subject, "Fix [cache].* for café");
  const sha = literal.commits[0].sha;
  assert.deepEqual(available(await commitHistory(root, { query: sha.slice(0, 9).toUpperCase(), offset: 0 })).commits, literal.commits);
  assert.equal(available(await commitHistory(root, { query: "--all", offset: 0 })).commits[0].subject, "Handle --all as text");
  assert.deepEqual(available(await commitHistory(root, { query: "no such message", offset: 0 })).commits, []);

  const first = available(await commitHistory(root, { query: "Change 2", offset: 0 }));
  assert.ok(first.head);
  const second = available(await commitHistory(root, { query: "Change 2", head: first.head, offset: COMMIT_PAGE_SIZE }));
  assert.equal(second.commits.length, COMMIT_PAGE_SIZE);
  assert.ok(second.commits.every((commit) => commit.subject.includes("Change 2")));
  assert.ok(second.commits.every((commit) => !first.commits.some((old) => old.sha === commit.sha)));
});

test("empty repositories have an empty history and malformed search cursors are rejected", async (t) => {
  const root = await repository(t, 0);
  assert.deepEqual(await commitHistory(root, { query: "", offset: 0 }), { status: "available", commits: [], head: null, offset: 0, hasMore: false });
  for (const request of [{ query: "", offset: -1 }, { query: "", offset: 100 }, { query: "", head: "--all", offset: 0 }, { query: "x".repeat(201), offset: 0 }, { query: "\0", offset: 0 }]) {
    assert.equal(isCommitHistoryRequest(request), false);
    assert.equal((await commitHistory(root, request)).status, "error");
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), "aic-no-git-history-"));
  t.onTestFinished(() => rm(outside, { recursive: true, force: true }));
  assert.equal((await commitHistory(outside, { query: "", offset: 0 })).status, "error");
});
