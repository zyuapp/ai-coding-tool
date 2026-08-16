import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles } from "../dist/main/main/workspace/git-changes.mjs";
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
});
