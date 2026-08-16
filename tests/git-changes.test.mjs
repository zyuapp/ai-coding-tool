import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, summarizeNumstat } from "../dist/main/main/workspace/git-changes.mjs";
import { UnknownWorkspaceError } from "../dist/main/main/workspace/workspace-service.mjs";

test("changed files distinguishes unknown workspaces", async () => {
  const result = await changedFiles("missing", { resolve: async () => { throw new UnknownWorkspaceError("missing"); } });
  assert.deepEqual(result, { status: "unknown", workspaceId: "missing" });
});

test("changed files distinguishes workspace resolution failures", async () => {
  const result = await changedFiles("broken", { resolve: async () => { throw new Error("registry unavailable"); } });
  assert.deepEqual(result, { status: "error", message: "registry unavailable" });
});

test("changed files distinguishes unavailable workspaces", async () => {
  const result = await changedFiles("gone", { resolve: async () => ({ status: "unavailable", workspace: { id: "gone", kind: "project", root: "/tmp/gone" }, reason: "missing" }) });
  assert.deepEqual(result, { status: "unavailable", reason: "missing" });
});

test("changed files returns an available file list through the Git adapter", async () => {
  const result = await changedFiles("current", { resolve: async () => ({ status: "available", workspace: { id: "current", kind: "project", root: process.cwd() } }) });
  assert.equal(result.status, "available");
  assert.ok(Array.isArray(result.files));
  assert.equal(typeof result.additions, "number");
  assert.equal(typeof result.deletions, "number");
  assert.ok(result.branch === null || typeof result.branch === "string");
});

test("numstat totals ignore binary files and renamed path records", () => {
  const output = ["12\t3\tsrc/a.ts", "-\t-\timage.png", "4\t1\t", "old.ts", "new.ts", ""].join("\0");
  assert.deepEqual(summarizeNumstat(output), { additions: 16, deletions: 4 });
});
