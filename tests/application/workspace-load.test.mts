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
    rankedAt: Date.now(), updatedAt: Date.now(),
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

test("a reviewer's own mode never becomes the new-thread draft", () => {
  const reviewer: Thread = { ...task("review"), role: "reviewer", executionPolicy: "bypass" };
  const older: Thread = { ...task("older"), executionPolicy: "plan" };
  const state = stateFromData(data([reviewer, older]));
  assert.equal(state.currentId, "review", "the app still opens on the newest thread");
  assert.equal(state.draftPolicy, "plan", "but the draft keeps the mode the user chose on the thread before it");
  assert.equal(stateFromData(data([reviewer])).draftPolicy, "confirm", "and a store holding only a reviewer falls back");
});

test("the draft's mode is held to the draft's engine when a reviewer runs on another", () => {
  const reviewer: Thread = { ...task("review"), engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash", executionPolicy: "bypass", role: "reviewer" };
  const older: Thread = { ...task("older"), executionPolicy: "autonomous" };
  const state = stateFromData(data([reviewer, older]));
  assert.equal(state.draftEngine, "opencode", "the draft still takes the newest thread's engine");
  assert.equal(state.draftModel, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(state.draftPolicy, "allow-edits", "and holds Auto to the nearest mode OpenCode has");
});

test("the draft's effort and model are held to the first thread's engine", () => {
  const luna: Thread = { ...task("luna"), engine: "codex", model: "gpt-6-luna", effort: "ultra", fastMode: true };
  const state = stateFromData(data([luna]));
  assert.equal(state.draftEffort, "max", "an effort the model lacks drops to the nearest one below");
  assert.equal(state.draftFastMode, true);

  const opencode: Thread = { ...task("open"), engine: "opencode", effort: "max" };
  const unnamed = stateFromData(data([opencode]));
  assert.equal(unnamed.draftEngine, "claude", "an engine yet to name a model leaves the draft on the default engine, never a Claude model on OpenCode");
  assert.equal(unnamed.draftModel, "opus");

  const named = stateFromData(data([opencode]), null, { opencode: { access: "ready", catalog: [{ id: "openrouter/z-ai/glm-5.3-flash", label: "GLM", description: "", contextWindow: 8_000, efforts: [{ id: "low", label: "Low" }] }] } });
  assert.equal(named.draftEngine, "opencode", "once it has named some, the draft takes its default");
  assert.equal(named.draftModel, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(named.draftEffort, "low");
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
