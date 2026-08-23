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

test("SQLite task storage keeps subagent activity in rows of its own", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-subagent-database-"));
  const file = path.join(directory, "tasks.sqlite");
  const database = new TaskDatabase(file);
  const task = {
    id: "task-1",
    title: "Delegate",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
  };
  const subagent = { id: "agent-1", description: "Explore", status: "working", startedAt: 1 };
  try {
    database.persist({
      tasks: [{
        task,
        messages: [],
        subagents: [{ index: 0, subagent }],
        activity: [{ subagentId: "agent-1", index: 0, item: { id: "activity-1", kind: "text", text: "Reading", at: 1 } }],
      }],
    });
    database.persist({
      tasks: [{
        task: { ...task, updatedAt: 3 },
        messages: [],
        subagents: [{ index: 0, subagent: { ...subagent, status: "completed", finishedAt: 4 } }],
        activity: [{ subagentId: "agent-1", index: 1, item: { id: "activity-2", kind: "tool", title: "Grep", text: "hits", at: 2 } }],
      }],
    });

    const loaded = database.load();
    assert.deepEqual(loaded.tasks[0].subagents[0].activity, []);
    assert.equal(loaded.tasks[0].subagents[0].status, "completed");
    assert.deepEqual(database.subagentActivity("task-1", "agent-1").map((item) => item.id), ["activity-1", "activity-2"]);
    assert.equal(JSON.parse(new DatabaseSync(file).prepare("SELECT data FROM tasks WHERE id = 'task-1'").get().data).subagents, undefined);
  } finally {
    database.close();
    await rm(directory, { recursive: true });
  }
});

test("SQLite task storage lifts subagents out of tasks written before they had rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-subagent-migration-"));
  const file = path.join(directory, "tasks.sqlite");
  const legacy = new TaskDatabase(file);
  const task = {
    id: "task-1",
    title: "Delegate",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    subagents: [{
      id: "agent-1",
      description: "Explore",
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      activity: [{ id: "activity-1", kind: "text", text: "Reading", at: 1 }],
    }],
  };
  legacy.persist({ tasks: [{ task, messages: [] }] });
  legacy.close();

  const database = new TaskDatabase(file);
  try {
    const loaded = database.load();
    assert.deepEqual(loaded.tasks[0].subagents, [{ ...task.subagents[0], activity: [] }]);
    assert.deepEqual(database.subagentActivity("task-1", "agent-1"), task.subagents[0].activity);
    assert.equal(JSON.parse(new DatabaseSync(file).prepare("SELECT data FROM tasks WHERE id = 'task-1'").get().data).subagents, undefined);
  } finally {
    database.close();
    await rm(directory, { recursive: true });
  }
});

test("SQLite automation storage keeps one row per task and drops unreadable rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-automation-database-"));
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

test("a project folder inside any of the app's own worktree roots is refused, and the rest of the delta still lands", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const worktreesRoot = path.join(directory, "worktrees");
  const legacyRoot = path.join(directory, "legacy-worktrees");
  const database = new TaskDatabase(path.join(directory, "tasks.sqlite"), { worktreesRoots: [worktreesRoot, legacyRoot] });
  const task = {
    id: "task-1",
    title: "Worktree work",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
  };
  const errors = [];
  const reportError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    database.persist({ projects: [{ id: "project-1", root: "/work" }], lastFolder: "/work", tasks: [{ task, messages: [] }] });

    database.persist({
      projects: [{ id: "project-1", root: path.join(worktreesRoot, "work-9aefd881") }],
      lastFolder: path.join(legacyRoot, "work-9aefd881"),
      tasks: [{ task: { ...task, updatedAt: 3 }, messages: [
        { index: 0, message: { id: "user-1", kind: "user", text: "Still saved", at: 1 } },
      ] }],
    });

    const loaded = database.load();
    assert.deepEqual(loaded.projects, [{ id: "project-1", root: "/work" }], "the folder on disk outlives a bad write");
    assert.equal(loaded.lastFolder, "/work", "the root the app used before is refused just the same");
    assert.equal(loaded.tasks[0].updatedAt, 3, "the transcript still saves");
    assert.deepEqual(loaded.tasks[0].messages.map((message) => message.text), ["Still saved"]);
    assert.equal(errors.length, 1, "and the refusal is said out loud");
  } finally {
    console.error = reportError;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a project folder that merely starts with the worktrees root's name is still allowed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const worktreesRoot = path.join(directory, "worktrees");
  const database = new TaskDatabase(path.join(directory, "tasks.sqlite"), { worktreesRoots: [worktreesRoot] });
  try {
    database.persist({ projects: [{ id: "project-1", root: `${worktreesRoot}-mine` }], tasks: [] });
    assert.deepEqual(database.load().projects, [{ id: "project-1", root: `${worktreesRoot}-mine` }]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkout stored inside its thread is lifted into a record other threads can claim", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const file = path.join(directory, "tasks.sqlite");
  const checkout = { id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "workspace-wt1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 };
  const stored = {
    id: "task-1",
    title: "Older thread",
    projectId: "project-1",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    worktree: { ...checkout, enteredAt: 3 },
  };
  try {
    const before = new DatabaseSync(file);
    before.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    before.prepare("INSERT INTO tasks (id, data) VALUES (?, ?)").run(stored.id, JSON.stringify(stored));
    before.close();

    const database = new TaskDatabase(file);
    try {
      database.persist({ projects: [{ id: "project-1", root: "/repo" }], tasks: [] });
      const loaded = database.load();

      assert.deepEqual(loaded.worktrees, [{ ...checkout, projectId: "project-1" }], "the checkout is filed under the project its thread was in");
      assert.equal(loaded.tasks[0].worktreeId, "wt1");
      assert.equal(loaded.tasks[0].worktreeEnteredAt, 3, "the fork the thread had already made stays with the thread");
      assert.equal(loaded.tasks[0].worktree, undefined);
      assert.deepEqual(database.claimedWorktrees(), ["/worktrees/repo-wt1"]);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkout is claimed while any thread is in it, and forgetting it frees every one of them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const database = new TaskDatabase(path.join(directory, "tasks.sqlite"));
  const worktree = { id: "wt1", projectId: "project-1", root: "/worktrees/repo-wt1", workspaceId: "workspace-wt1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 };
  const thread = (id, overrides) => ({
    id,
    title: id,
    projectId: "project-1",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    ...overrides,
  });
  try {
    database.persist({
      projects: [{ id: "project-1", root: "/repo" }],
      worktrees: [worktree],
      tasks: [
        { task: thread("task-a", { worktreeId: "wt1", worktreeEnteredAt: 4 }), messages: [] },
        { task: thread("task-b", { worktreeId: "wt1" }), messages: [] },
        { task: thread("task-c"), messages: [] },
      ],
    });

    assert.deepEqual(database.claimedWorktrees(), ["/worktrees/repo-wt1"], "one entry however many threads claim it");
    assert.deepEqual(database.worktreeRoots(), ["/worktrees/repo-wt1"]);

    database.persist({ tasks: [{ task: thread("task-a", { worktreeId: "wt1", worktreeEnteredAt: 4, archivedAt: 9 }), messages: [] }] });
    assert.deepEqual(database.claimedWorktrees(), ["/worktrees/repo-wt1"], "a live thread is still in there");
    database.persist({ tasks: [{ task: thread("task-b", { worktreeId: "wt1", archivedAt: 9 }), messages: [] }] });
    assert.deepEqual(database.claimedWorktrees(), [], "an archived thread keeps nothing open, so the checkout is reaped");
    assert.deepEqual(database.worktreeRoots(), ["/worktrees/repo-wt1"], "and its record is still there to be forgotten with it");


    assert.equal(database.forgetWorktrees(["/worktrees/repo-wt1"]), 2, "both threads are freed, not just the first");
    const loaded = database.load();
    assert.deepEqual(loaded.worktrees, [], "and the record goes with the directory");
    assert.deepEqual(loaded.tasks.map((task) => task.worktreeId), [undefined, undefined, undefined]);
    assert.equal(loaded.tasks.find((task) => task.id === "task-a").worktreeEnteredAt, undefined);
    assert.deepEqual(database.claimedWorktrees(), []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite task storage keeps what a thread's runs found, and which of its messages were withdrawn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claudex-task-database-"));
  const database = new TaskDatabase(path.join(directory, "tasks.sqlite"));
  const task = {
    id: "task-1",
    title: "Poll Datadog",
    executionPolicy: "autonomous",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    findings: [{ id: "finding-1", headline: "Checkout is returning 5xx", key: "checkout", at: 30 }],
    updatedAt: 31,
  };
  try {
    database.persist({ tasks: [{ task, messages: [
      { index: 0, message: { id: "label", kind: "user", text: "Poll", detail: "Automation run #2", withdrawn: true, at: 10 } },
      { index: 1, message: { id: "reply", kind: "assistant", text: "Nothing new", quiet: true, at: 11 } },
    ] }] });

    const [loaded] = database.load().tasks;
    assert.deepEqual(loaded.findings, task.findings);
    assert.deepEqual(loaded.messages.map((message) => message.withdrawn), [true, true], "the second was stored under the older name and reads back withdrawn");
  } finally {
    database.close();
    await rm(directory, { recursive: true });
  }
});
