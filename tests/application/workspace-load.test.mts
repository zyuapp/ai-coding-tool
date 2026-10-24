import assert from "node:assert/strict";
import { test } from "vitest";

import { stateFromData, withStoreData } from "../../src/application/workspace-load.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import { legacyProjectId } from "../../src/domain/project.ts";
import { THREAD_STORE_VERSION, type ThreadStoreData } from "../../src/domain/thread-storage.ts";
import type { Thread } from "../../src/domain/thread.ts";

function task(id: string): Thread {
  return {
    id,
    title: id,
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: Date.now(),
  };
}

function data(tasks: Thread[], lastFolder: string | null = null): ThreadStoreData {
  return { version: THREAD_STORE_VERSION, tasks, projects: [{ id: "project-1", root: "/project" }], worktrees: [], lastFolder };
}

test("a store answer opens on its first thread", () => {
  const state = stateFromData(data([task("first"), task("second")]));
  assert.equal(state.currentId, "first");
  assert.deepEqual(state.history, ["first"]);
  assert.equal(state.draftProjectId, "project-1");
  assert.deepEqual([...state.expandedProjects], ["project-1"]);
});

test("a last folder no project holds comes back as a project", () => {
  const state = stateFromData(data([], "/older"));
  assert.deepEqual(state.projects.map((project) => project.id), ["project-1", legacyProjectId("/older")]);
  assert.equal(state.draftProjectId, legacyProjectId("/older"));
  assert.equal(state.currentId, null);
});

test("an untouched session takes the thread the store opens on", () => {
  const loaded = withStoreData(emptyWorkspaceState(), data([task("first")]));
  assert.equal(loaded.currentId, "first");
  assert.equal(loaded.draftProjectId, "project-1");
});

test("a session already typed into keeps where it is when the store answers", () => {
  const loaded = withStoreData({ ...emptyWorkspaceState(), prompts: { draft: "hello" } }, data([task("first")]));
  assert.deepEqual(loaded.threads.map((thread) => thread.id), ["first"]);
  assert.equal(loaded.currentId, null);
  assert.equal(loaded.draftProjectId, null);
  assert.deepEqual(loaded.prompts, { draft: "hello" });
});
