import assert from "node:assert/strict";
import { test } from "vitest";
import {
  folderName,
  legacyProjectId,
  migrateV1ToV2,
  parseTaskStore,
  retainedTasks,
  serializeTaskStore,
  validateTaskStoreData,
  type TaskMessage,
  type TaskStoreData,
} from "../../src/domain/task.ts";
import { LEGACY_TASK_STORE_KEYS, TASK_STORE_KEYS, TaskStore } from "../../src/application/task-store.ts";

const task = {
  id: "task-1",
  title: "Fix the app",
  folder: "/work/ai-coding-tool",
  sessionId: "session-1",
  mode: "acceptEdits",
  messages: [{ id: "message-1", kind: "user", text: "Fix it", at: 10 }],
  changedFiles: [" M src/App.tsx"],
  updatedAt: 20,
};

test("a folder name ignores leading, repeated, and trailing path separators", () => {
  assert.equal(folderName("/work//claudex///"), "claudex");
  assert.equal(folderName("///"), "///");
});

type LegacyValues = { tasks: string; projects: string; worktrees: null; lastFolder: string };

function legacyValues(overrides: Partial<LegacyValues> = {}): LegacyValues {
  return {
    tasks: JSON.stringify([task]),
    projects: JSON.stringify(["/work/ai-coding-tool"]),
    worktrees: null,
    lastFolder: "/work/ai-coding-tool",
    ...overrides,
  };
}

/** Invalid historical rows still need encoding before they cross the parser's trust boundary. */
function serializeUnchecked(value: unknown) {
  return serializeTaskStore(value as TaskStoreData);
}

test("migrates all v1 keys and keeps a resumable transcript", () => {
  const result = migrateV1ToV2(legacyValues());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const migrated = result.data.tasks[0];
  assert.equal(result.data.version, 2);
  assert.deepEqual(result.data.projects, [{ id: legacyProjectId("/work/ai-coding-tool"), root: "/work/ai-coding-tool" }]);
  assert.equal(migrated.projectId, legacyProjectId("/work/ai-coding-tool"));
  assert.equal(migrated.executionPolicy, "allow-edits");
  assert.deepEqual(migrated.continuation, { provider: "claude", value: "session-1" });
  assert.equal(migrated.continuationStatus, "available");
  assert.deepEqual(migrated.lastChangeSnapshot, { files: [" M src/App.tsx"], capturedAt: 20 });
  assert.equal(result.data.lastFolder, "/work/ai-coding-tool");
  assert.deepEqual(result.preservedV1, legacyValues());
  assert.equal(legacyProjectId("/work/ai-coding-tool"), legacyProjectId("/work/ai-coding-tool/"));
});

test("loads the previous Threadline namespace and saves it under AI Coding Tool", () => {
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [LEGACY_TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [LEGACY_TASK_STORE_KEYS.v1.projects, raw.projects],
    [LEGACY_TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const store = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  });
  const loaded = store.load();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(store.save(loaded.data).ok, true);
  assert.equal(typeof memory.get(TASK_STORE_KEYS.v2.envelope), "string");
});

test("malformed storage preserves the payload and blocks writes", () => {
  const raw = legacyValues({ tasks: "{not-json" });
  const result = parseTaskStore(raw);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.canWrite, false);
  assert.deepEqual(result.raw, raw);
  assert.deepEqual(result.preservedV1, raw);

  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const store = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(store.save({ version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null }).ok, false);
  assert.equal(memory.has(TASK_STORE_KEYS.v2.tasks), false);
});

test("serializes and parses v2 data without changing it", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  migrated.data.tasks[0].subagents = [{
    id: "agent-1",
    description: "Inspect storage",
    status: "completed",
    summary: "Stored",
    startedAt: 21,
    finishedAt: 22,
    activity: [{ id: "activity-1", kind: "text", text: "Done", at: 22 }],
  }];
  const serialized = serializeTaskStore(migrated.data);
  const parsed = parseTaskStore(serialized);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data, migrated.data);
  assert.equal(parsed.sourceVersion, 2);
  assert.equal(parsed.preservedV1, null);
});

test("idle subagents survive reload, while work interrupted by restart becomes stopped", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  migrated.data.tasks[0].subagents = [
    { id: "idle", description: "Ready", sessionScoped: true, status: "idle", startedAt: 10, activity: [] },
    { id: "working", description: "Interrupted", sessionScoped: true, status: "working", startedAt: 11, activity: [] },
  ];

  const parsed = parseTaskStore(serializeTaskStore(migrated.data));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.tasks[0].subagents?.[0]?.status, "idle");
  assert.equal(parsed.data.tasks[0].subagents?.[0]?.finishedAt, undefined);
  assert.equal(parsed.data.tasks[0].subagents?.[1]?.status, "stopped");
  assert.equal(parsed.data.tasks[0].subagents?.[1]?.finishedAt, migrated.data.tasks[0].updatedAt);
});

test("validating decoded v2 data matches serialized parsing", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const decoded = {
    ...migrated.data,
    tasks: [{
      ...migrated.data.tasks[0],
      model: "default",
      contextWindow: "1m",
      silencedKeys: ["latency"],
      messages: [{ ...migrated.data.tasks[0].messages[0], quiet: true }],
    }],
  };

  const parsed = parseTaskStore(serializeUnchecked(decoded));
  const original = structuredClone(decoded);
  const validated = validateTaskStoreData(decoded);
  assert.equal(validated.ok, parsed.ok);
  if (validated.ok && parsed.ok) assert.deepEqual(validated.data, parsed.data);
  assert.deepEqual(decoded, original, "validation sanitizes its result without changing decoded rows");

  const invalid = { ...decoded, tasks: [{ ...decoded.tasks[0], title: 42 }] };
  const hidden = parseTaskStore(serializeUnchecked(invalid));
  const directlyHidden = validateTaskStoreData(invalid);
  assert.equal(directlyHidden.ok, true);
  assert.equal(hidden.ok, true);
  if (!directlyHidden.ok || !hidden.ok) return;
  assert.deepEqual(directlyHidden.data.tasks, []);
  assert.equal(directlyHidden.hiddenTasks, 1);
  assert.equal(hidden.hiddenTasks, 1);
});

test("current tasks and unexpired archives keep their existing objects", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const tasks = migrated.data.tasks;
  const validated = validateTaskStoreData(migrated.data);

  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.data.tasks[0], tasks[0]);
  assert.equal(validated.data.tasks[0].messages, tasks[0].messages);
  assert.equal(retainedTasks(tasks, tasks[0].updatedAt), tasks);
});

test("invalid continuation keeps messages and marks the task non-resumable", () => {
  const raw = legacyValues({
    tasks: JSON.stringify([{ ...task, sessionId: { provider: "claude" } }]),
  });
  const result = migrateV1ToV2(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.tasks[0].continuation, undefined);
  assert.equal(result.data.tasks[0].continuationStatus, "invalid");
  assert.deepEqual(result.data.tasks[0].messages, task.messages);
});

test("an empty store is a clean version-zero result", () => {
  const result = parseTaskStore({ tasks: null, projects: null, worktrees: null, lastFolder: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sourceVersion, 0);
  assert.deepEqual(result.data, { version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null });
});

test("salvages a v2 task with an invalid continuation", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  tasks.value[0].continuation = { provider: "", value: "" };
  tasks.value[0].continuationStatus = "available";
  const result = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.tasks[0].continuation, undefined);
  assert.equal(result.data.tasks[0].continuationStatus, "invalid");
  assert.deepEqual(result.data.tasks[0].messages, migrated.data.tasks[0].messages);
});

test("a task saved with the old attention dot still loads, without one", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  tasks.value[0].attention = "approval";
  tasks.value[0].attentionRead = true;
  const result = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.tasks.length, 1, "a dot the app no longer keeps is no reason to drop the thread");
  assert.equal(result.data.tasks[0].outcome, undefined);
  assert.equal("attention" in result.data.tasks[0], false, "the retired dot is not carried back out to the store");
  assert.equal("attentionRead" in result.data.tasks[0], false);
});

test("hides a v2 task with an invalid policy or timestamp and keeps the store writable", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  tasks.value.push({ ...tasks.value[0], id: "unreadable", executionPolicy: "not-a-policy", updatedAt: "not-a-timestamp" });
  const result = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.tasks.map((task) => task.id), [migrated.data.tasks[0].id]);
  assert.equal(result.hiddenTasks, 1);
});

test("hides a v2 task that references an unknown project", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const projects = JSON.parse(serialized.projects!);
  projects.value = [];
  const result = parseTaskStore({ ...serialized, projects: JSON.stringify(projects) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.tasks, []);
  assert.equal(result.hiddenTasks, 1);
});

test("a thread saved by a newer build is hidden rather than failing the store", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  tasks.value.push({ ...tasks.value[0], id: "from-the-future", engine: "an-engine-this-build-lacks" });
  const result = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.tasks.map((task) => task.id), [migrated.data.tasks[0].id]);
  assert.equal(result.hiddenTasks, 1);
});

test("storage write failures disable future writes without touching v1", () => {
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const original = new Map(memory);
  const store = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      if (key === TASK_STORE_KEYS.v2.envelope) throw new Error("quota exceeded");
      memory.set(key, value);
    },
  });
  const loaded = store.load();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const saved = store.save(loaded.data);
  assert.deepEqual(saved, { ok: false, reason: "storage", error: "quota exceeded" });
  assert.equal(memory.get(TASK_STORE_KEYS.v1.tasks), original.get(TASK_STORE_KEYS.v1.tasks));
  assert.equal(memory.get(TASK_STORE_KEYS.v1.projects), original.get(TASK_STORE_KEYS.v1.projects));
  assert.equal(memory.get(TASK_STORE_KEYS.v1.lastFolder), original.get(TASK_STORE_KEYS.v1.lastFolder));
  assert.equal(store.save(loaded.data).ok, false);
});

test("writes v2 atomically as one envelope and leaves v1 untouched", () => {
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const store = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  });
  const loaded = store.load();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  assert.equal(store.save(loaded.data).ok, true);
  assert.equal(typeof memory.get(TASK_STORE_KEYS.v2.envelope), "string");
  assert.equal(memory.has(TASK_STORE_KEYS.v2.tasks), false);
  assert.equal(memory.has(TASK_STORE_KEYS.v2.projects), false);
  assert.equal(memory.has(TASK_STORE_KEYS.v2.lastFolder), false);
  assert.equal(memory.get(TASK_STORE_KEYS.v1.tasks), raw.tasks);
  assert.equal(memory.get(TASK_STORE_KEYS.v1.projects), raw.projects);
  assert.equal(memory.get(TASK_STORE_KEYS.v1.lastFolder), raw.lastFolder);

  const reloaded = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }).load();
  assert.equal(reloaded.ok, true);
  if (reloaded.ok) assert.deepEqual(reloaded.data, loaded.data);
});

test("ignores an incomplete split-v2 write and recovers from intact v1", () => {
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
    [TASK_STORE_KEYS.v2.tasks, serializeTaskStore({ version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null }).tasks],
  ]);
  const result = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }).load();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceVersion, 1);
    assert.equal(result.data.tasks[0].id, task.id);
  }
});

test("storage read failures return a non-writable error", () => {
  const store = new TaskStore({
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("must not write");
    },
  });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.errorKind, "storage");
  assert.equal(loaded.canWrite, false);
  assert.match(loaded.errors[0], /storage unavailable/);
});

test("v2 round-trips model, context usage, and archive metadata", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const richTask = {
    ...migrated.data.tasks[0],
    model: "opus" as const,
    contextUsage: { tokens: 42_000, limit: 1_000_000, model: "claude-opus" },
    archivedAt: 30,
  };
  const data: TaskStoreData = { ...migrated.data, tasks: [richTask] };
  const parsed = parseTaskStore(serializeTaskStore(data));

  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.data, data);
});

test("v2 hides a task with invalid model or usage values", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    (value) => { value.model = "future"; },
    (value) => { value.contextUsage = { tokens: -1, limit: 200_000, model: "claude" }; },
    (value) => { value.contextUsage = { tokens: 1, limit: 0, model: "claude" }; },
    (value) => { value.contextUsage = { tokens: 1, limit: 200_000, model: "" }; },
    (value) => { value.archivedAt = Number.NaN; },
  ];
  for (const mutate of mutations) {
    const serialized = serializeTaskStore(migrated.data);
    const tasks = JSON.parse(serialized.tasks!);
    mutate(tasks.value[0]);
    const parsed = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.data.tasks, []);
    assert.equal(parsed.hiddenTasks, 1);
  }
});

test("v2 drops the retired default model and context window instead of rejecting the task", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  Object.assign(tasks.value[0], { model: "default", contextWindow: "1m" });

  const parsed = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal("model" in parsed.data.tasks[0], false);
  assert.equal("contextWindow" in parsed.data.tasks[0], false);
});

test("v2 tasks written before the engine was recorded load as Claude threads", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const serialized = serializeTaskStore(migrated.data);
  const tasks = JSON.parse(serialized.tasks!);
  delete tasks.value[0].engine;

  const parsed = parseTaskStore({ ...serialized, tasks: JSON.stringify(tasks) });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.tasks[0].engine, "claude");
  assert.deepEqual(parsed.data, migrated.data);
});

test("a corrupt v2 envelope blocks writes instead of falling back to older data", () => {
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v2.envelope, "{broken"],
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const store = new TaskStore({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  });

  const loaded = store.load();

  assert.equal(loaded.ok, false);
  assert.equal(loaded.sourceVersion, 2);
  assert.equal(store.save({ version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null }).ok, false);
});

test("a valid v2 envelope takes precedence over split and v1 values", () => {
  const envelopeData: TaskStoreData = { version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null };
  const envelope = serializeTaskStore(envelopeData);
  const split = serializeTaskStore({ version: 2, tasks: [], projects: [], worktrees: [], lastFolder: "/split" });
  const raw = legacyValues();
  const memory = new Map<string, string | null>([
    [TASK_STORE_KEYS.v2.envelope, JSON.stringify(envelope)],
    [TASK_STORE_KEYS.v2.tasks, split.tasks],
    [TASK_STORE_KEYS.v2.projects, split.projects],
    [TASK_STORE_KEYS.v2.lastFolder, split.lastFolder],
    [TASK_STORE_KEYS.v1.tasks, raw.tasks],
    [TASK_STORE_KEYS.v1.projects, raw.projects],
    [TASK_STORE_KEYS.v1.lastFolder, raw.lastFolder],
  ]);
  const reads: string[] = [];
  const loaded = new TaskStore({
    getItem: (key) => { reads.push(key); return memory.get(key) ?? null; },
    setItem: (key, value) => memory.set(key, value),
  }).load();

  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.data, envelopeData);
  assert.deepEqual(reads, [TASK_STORE_KEYS.v2.envelope], "a complete envelope never materializes fallback generations");
});

test("v1 migration deduplicates project roots with trailing separators", () => {
  const result = migrateV1ToV2(legacyValues({ projects: JSON.stringify(["/work/ai-coding-tool/"]) }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.projects, [{ id: legacyProjectId("/work/ai-coding-tool"), root: "/work/ai-coding-tool" }]);
  assert.equal(result.data.tasks[0].projectId, result.data.projects[0].id);
});

test("storage written before a checkout could hold two threads lifts the checkout out of the thread", () => {
  const checkout = { id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "workspace-wt1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 };
  const stored = {
    id: "task-1",
    title: "Older thread",
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    worktree: { ...checkout, enteredAt: 3 },
  };
  const result = parseTaskStore({
    tasks: JSON.stringify({ version: 2, value: [stored] }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/repo" }] }),
    worktrees: null,
    lastFolder: JSON.stringify({ version: 2, value: null }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.worktrees, [{ ...checkout, projectId: "project-1" }]);
  assert.equal(result.data.tasks[0].worktreeId, "wt1");
  assert.equal(result.data.tasks[0].worktreeEnteredAt, 3, "the fork the thread had already made stays with the thread");
  assert.equal("worktree" in result.data.tasks[0], false);
});

test("a thread claiming a checkout that is not there is local again, rather than making the store unwritable", () => {
  const stored = {
    id: "task-1",
    title: "Reconciled away",
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    worktreeId: "wt-gone",
    worktreeEnteredAt: 3,
  };
  const result = parseTaskStore({
    tasks: JSON.stringify({ version: 2, value: [stored] }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/repo" }] }),
    worktrees: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.tasks[0].worktreeId, undefined);
  assert.equal(result.data.tasks[0].worktreeEnteredAt, undefined);
});

test("duplicate checkout ids keep the first record before invalid projects are removed", () => {
  const checkout = (id: string, projectId: string, root: string) => ({ id, projectId, root, workspaceId: `workspace-${root}`, baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 });
  const embedded = {
    id: "task-shared",
    title: "Shared checkout",
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
    worktree: { ...checkout("shared", "project-1", "/lifted"), enteredAt: 3 },
  };
  const blocked = {
    ...embedded,
    id: "task-blocked",
    title: "Blocked checkout",
    worktree: undefined,
    worktreeId: "blocked",
    worktreeEnteredAt: 4,
  };
  const first = checkout("shared", "project-1", "/first");
  const result = parseTaskStore({
    tasks: JSON.stringify({ version: 2, value: [embedded, blocked] }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/repo" }] }),
    worktrees: JSON.stringify({
      version: 2,
      value: [
        first,
        checkout("shared", "project-1", "/second"),
        checkout("blocked", "missing-project", "/invalid-first"),
        checkout("blocked", "project-1", "/valid-second"),
      ],
    }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.worktrees, [first], "stored records win duplicates, including lifted records");
  assert.equal(result.data.tasks[0].worktreeId, "shared");
  assert.equal(result.data.tasks[1].worktreeId, undefined, "filtering after deduplication does not revive a later duplicate");
  assert.equal(result.data.tasks[1].worktreeEnteredAt, undefined);
});

test("what a thread's runs found survives being written and read back, and a malformed one hides the thread", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  migrated.data.tasks[0].findings = [{ id: "finding-1", headline: "Checkout is returning 5xx", detail: "12 in the last hour", key: "checkout", at: 30 }];
  migrated.data.tasks[0].messages = [{ ...task.messages[0], withdrawn: true }, { ...task.messages[0], id: "message-2", quiet: true }] as unknown as TaskMessage[];
  Object.assign(migrated.data.tasks[0], { silencedKeys: ["latency"] });

  const parsed = parseTaskStore(serializeTaskStore(migrated.data));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tasks[0].findings, migrated.data.tasks[0].findings);
  assert.deepEqual(parsed.data.tasks[0].messages.map((message) => message.withdrawn), [true, true], "a message stored under the older name reads back withdrawn");
  assert.deepEqual(parsed.data.tasks[0].handledIssues, ["latency"], "and so do the issues the user filed away");

  const broken = parseTaskStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...migrated.data.tasks[0], findings: [{ id: "finding-1", at: 30 }] }] }));
  assert.equal(broken.ok, true);
  if (!broken.ok) return;
  assert.deepEqual(broken.data.tasks, [], "a finding with nothing to say is not a finding");
  assert.equal(broken.hiddenTasks, 1);
});
