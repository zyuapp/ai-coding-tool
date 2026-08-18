import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
    database.close();
    await rm(directory, { recursive: true });
  }
});

test("SQLite automation storage keeps one row per task and drops unreadable rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-automation-database-"));
  const file = path.join(directory, "tasks.sqlite");
  const database = new TaskDatabase(file);
  const automation = {
    id: "automation-1",
    taskId: "task-1",
    prompt: "check whether the PR is approved",
    schedule: "* * * * *",
    paused: false,
    createdAt: 1,
    updatedAt: 2,
    runCount: 0,
  };
  try {
    database.saveAutomation(automation);
    database.saveAutomation({ ...automation, runCount: 7, updatedAt: 9, lastStatus: "succeeded", lastRunAt: 8 });
    database.saveAutomation({ ...automation, id: "automation-2", taskId: "task-2" });

    const stored = database.listAutomations();
    assert.deepEqual(stored.map((row) => row.taskId), ["task-1", "task-2"]);
    assert.equal(stored[0].runCount, 7);
    assert.equal(stored[0].lastStatus, "succeeded");

    database.deleteAutomation("automation-2");
    assert.deepEqual(database.listAutomations().map((row) => row.id), ["automation-1"]);
  } finally {
    database.close();
  }

  const reopened = new TaskDatabase(file);
  try {
    assert.equal(reopened.listAutomations()[0].prompt, "check whether the PR is approved", "automations survive a restart");
    reopened.saveAutomation({ ...automation, id: "automation-3", taskId: "task-3", schedule: 42 });
    assert.deepEqual(reopened.listAutomations().map((row) => row.id), ["automation-1"], "a row with the wrong shape never reaches the scheduler");
  } finally {
    reopened.close();
  }

  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO automations (id, task_id, data) VALUES (?, ?, ?)").run("automation-4", "task-4", "{not json");
  raw.close();

  const corrupt = new TaskDatabase(file);
  try {
    assert.deepEqual(corrupt.listAutomations().map((row) => row.id), ["automation-1"], "unparseable JSON is skipped rather than thrown");
  } finally {
    corrupt.close();
    await rm(directory, { recursive: true });
  }
});
