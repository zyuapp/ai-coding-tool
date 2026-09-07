import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import type { PersistedTask } from "../../src/contracts/task-store.ts";
import { TaskDatabaseService } from "../../src/main/task-database-service.mts";

const workerURL = new URL("../../dist/main/main/task-database-worker.mjs", import.meta.url);
const task: PersistedTask = {
  id: "task", title: "Worker storage", engine: "claude", executionPolicy: "confirm", continuationStatus: "none",
  lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
};

test("worker close drains queued writes and preserves ordering across a restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-worker-storage-"));
  const file = path.join(directory, "tasks.sqlite");
  const database = await TaskDatabaseService.open(file, { workerURL });
  try {
    const writes = Array.from({ length: 40 }, (_, index) => database.persist({ tasks: [{
      task: { ...task, updatedAt: index },
      messages: [{ index, message: { id: `message-${index}`, kind: "assistant", text: `Reply ${index}`, at: index } }],
    }] }));
    const closed = database.close();
    assert.equal(database.close(), closed);
    await assert.rejects(database.persist({ tasks: [] }), /closing/);
    await Promise.all([...writes, closed]);
    const reopened = await TaskDatabaseService.open(file, { workerURL });
    try {
      const summaries = await reopened.loadSummaries();
      assert.equal(summaries!.tasks[0].historySummary!.messageCount, 40);
      assert.deepEqual(summaries!.tasks[0].messages, []);
      const messages = await reopened.loadThreadMessages(task.id);
      assert.equal(messages.length, 40);
      assert.equal(messages[39].text, "Reply 39");
      assert.equal((await reopened.load())!.tasks[0].updatedAt, 39);
    } finally {
      await reopened.close();
    }
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker storage returns write failures and continues serving subsequent operations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-worker-failure-"));
  const database = await TaskDatabaseService.open(path.join(directory, "tasks.sqlite"), { workerURL });
  const automation = { id: "a", taskId: task.id, prompt: "Poll", schedule: "0 * * * *", paused: false, runCount: 0, createdAt: 1, updatedAt: 1 };
  try {
    await database.saveAutomation(automation);
    await assert.rejects(database.saveAutomation({ ...automation, id: "duplicate" }), /UNIQUE/);
    assert.deepEqual(await database.listAutomations(), [automation]);
    await database.deleteAutomation(automation.id);
    await database.flush();
    assert.deepEqual(await database.listAutomations(), []);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker initialization failure rejects opening the store", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-worker-open-"));
  try {
    await assert.rejects(TaskDatabaseService.open(path.join(directory, "missing", "tasks.sqlite"), { workerURL }), /unable to open database/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("a rejected close leaves the worker usable and a later close can succeed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-worker-close-retry-"));
  const file = path.join(directory, "tasks.sqlite");
  const fixture = path.join(directory, "close-retry-worker.mjs");
  const databaseURL = new URL("../../dist/main/main/task-database.mjs", import.meta.url);
  await writeFile(fixture, `
    import { TaskDatabase } from ${JSON.stringify(databaseURL.href)};
    const close = TaskDatabase.prototype.close;
    let attempts = 0;
    TaskDatabase.prototype.close = function () {
      if (++attempts === 1) throw new Error("Database close is temporarily busy.");
      return close.call(this);
    };
    await import(${JSON.stringify(workerURL.href)});
  `);
  const database = await TaskDatabaseService.open(file, { workerURL: pathToFileURL(fixture) });
  try {
    await database.persist({ tasks: [{ task, messages: [{ index: 0, message: { id: "first", kind: "assistant", text: "Before close", at: 1 } }] }] });
    const firstClose = database.close();
    assert.equal(database.close(), firstClose);
    await assert.rejects(database.persist({ tasks: [] }), /closing/);
    await assert.rejects(firstClose, /temporarily busy/);
    await database.persist({ tasks: [{ task, messages: [{ index: 1, message: { id: "second", kind: "assistant", text: "After rejected close", at: 2 } }] }] });
    await database.flush();
    assert.deepEqual((await database.loadThreadMessages(task.id)).map((message) => message.text), ["Before close", "After rejected close"]);
    const retried = database.close();
    assert.notEqual(retried, firstClose);
    assert.equal(database.close(), retried);
    await retried;
    const reopened = await TaskDatabaseService.open(file, { workerURL });
    try {
      assert.equal((await reopened.loadThreadMessages(task.id)).length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    await database.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
