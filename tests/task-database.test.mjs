import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskDatabase } from "../dist/main/main/task-database.mjs";

test("SQLite task storage appends and updates messages without rewriting the transcript", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const database = new TaskDatabase(path.join(directory, "tasks.sqlite"));
  const task = {
    id: "task-1",
    title: "Render markdown",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
  };
  try {
    database.persist({
      projects: [{ id: "project-1", root: "/work" }],
      lastFolder: "/work",
      tasks: [{ task, messages: [
        { index: 0, message: { id: "user-1", kind: "user", text: "Hello", at: 1 } },
        { index: 1, message: { id: "assistant-1", kind: "assistant", text: "First", at: 2 } },
      ] }],
    });
    database.persist({
      tasks: [{ task: { ...task, updatedAt: 3 }, messages: [
        { index: 1, message: { id: "assistant-1", kind: "assistant", text: "First\nSecond", at: 2 } },
      ] }],
    });

    const loaded = database.load();
    assert.equal(loaded.lastFolder, "/work");
    assert.deepEqual(loaded.projects, [{ id: "project-1", root: "/work" }]);
    assert.deepEqual(loaded.tasks[0].messages.map((message) => message.text), ["Hello", "First\nSecond"]);
    assert.equal(loaded.tasks[0].updatedAt, 3);
  } finally {
    database.close();
    await rm(directory, { recursive: true });
  }
});
