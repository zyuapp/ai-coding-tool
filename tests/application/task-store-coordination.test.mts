import assert from "node:assert/strict";
import { test } from "vitest";
import { migrateV1ToV2, parseThreadStore, serializeThreadStore, type ThreadStoreData } from "../../src/domain/thread-storage.ts";

/** One thread as the oldest store wrote it, which every test here dresses up as a coordinator or one of its threads. */
function legacyValues() {
  const task = { id: "task-1", title: "Fix the app", folder: "/work/ai-coding-tool", mode: "acceptEdits", messages: [{ id: "message-1", kind: "user", text: "Fix it", at: 10 }], changedFiles: [], updatedAt: 20 };
  return { tasks: JSON.stringify([task]), projects: JSON.stringify(["/work/ai-coding-tool"]), worktrees: null, lastFolder: "/work/ai-coding-tool" };
}

/** Invalid historical rows still need encoding before they cross the parser's trust boundary. */
function serializeUnchecked(value: unknown) {
  return serializeThreadStore(value as ThreadStoreData);
}

test("what a coordinator's threads run on survives a reload, on a replaced model's successor, and a malformed one costs the thread nothing else", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const lead = { ...migrated.data.tasks[0], role: "coordinator" as const, threadModel: { model: "gpt-6.1-sol" as const, effort: "ultra" as const } };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [lead] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tasks[0].threadModel, { model: "gpt-6.1-sol", effort: "ultra" });

  const retired = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, threadModel: { model: "gpt-5.6-luna", effort: "max" } }] }));
  assert.equal(retired.ok, true);
  if (!retired.ok) return;
  assert.deepEqual(retired.data.tasks[0].threadModel, { model: "gpt-6-luna", effort: "max" });

  for (const threadModel of [{ model: "gpt-0" }, { model: "opus", effort: "furious" }, "opus"]) {
    const broken = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, threadModel }] }));
    assert.equal(broken.ok, true);
    if (!broken.ok) return;
    assert.equal(broken.hiddenTasks, 0, "the thread still loads");
    assert.equal(broken.data.tasks[0].threadModel, undefined, "without the choice it could not read");
    assert.deepEqual(broken.data.tasks[0].messages, lead.messages);
  }
});

test("a coordinator's memory round-trips, a note written under a longer limit still loads, and a memory it cannot read is dropped", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const memory = { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads first", at: 1 }, { id: "n3", text: "x".repeat(2_000), at: 2 }], revision: 3, heard: 1 };
  const lead = { ...migrated.data.tasks[0], role: "coordinator" as const, memory };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [lead] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tasks[0].memory, memory);

  for (const broken of [{ notes: "none", revision: 1 }, { notes: [{ id: "n1", text: 3, at: 1 }], revision: 1 }, { notes: [], revision: -1 }, "remember this"]) {
    const loaded = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, memory: broken }] }));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.hiddenTasks, 0, "the thread still loads");
    assert.equal(loaded.data.tasks[0].memory, undefined, "without the memory it could not read");
    assert.deepEqual(loaded.data.tasks[0].messages, lead.messages);
  }
});

test("a resolved thread and how its pull request stood survive a reload, an old link still loads, and one it cannot read is dropped", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const pullRequest = { number: 212, url: "https://github.com/o/r/pull/212", state: "open" as const, title: "Fix it", checks: "failing" as const, review: "approved" as const, conflicts: true as const };
  const member = { ...migrated.data.tasks[0], parentId: "lead", resolvedAt: 5, pullRequest };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [member] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.tasks[0].resolvedAt, 5);
  assert.deepEqual(parsed.data.tasks[0].pullRequest, pullRequest);

  const old = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [{ ...member, pullRequest: { number: 212, url: pullRequest.url } }] }));
  assert.equal(old.ok, true);
  if (!old.ok) return;
  assert.deepEqual(old.data.tasks[0].pullRequest, { number: 212, url: pullRequest.url });

  for (const broken of [{ resolvedAt: "yesterday" }, { pullRequest: { ...pullRequest, checks: "flaky" } }, { pullRequest: { number: 0, url: "" } }]) {
    const loaded = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...member, ...broken }] }));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.hiddenTasks, 0, "the thread still loads");
    assert.deepEqual(loaded.data.tasks[0].messages, member.messages);
    const [field] = Object.keys(broken) as ("resolvedAt" | "pullRequest")[];
    assert.equal(loaded.data.tasks[0][field!], undefined, `without the ${field} it could not read`);
  }
});

test("a coordinator's suggested threads survive a reload, on a replaced model's successor, and one it cannot read is dropped alone", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const brief = { intent: "fix the login test", doneWhen: "it passes", delivers: "pull-request" as const };
  const suggested = { id: "p1", title: "Fix login", named: true as const, prompt: "Fix it", brief, place: { project: "project-1", worktree: true }, model: "gpt-6-luna" as const, effort: "low" as const, role: "implementer" as const, proposedAt: 3, error: "No project matches." };
  const plain = { id: "p2", title: "Docs", prompt: "Write them", brief, place: { worktreeId: "wt-1" }, proposedAt: 4 };
  const lead = { ...migrated.data.tasks[0], role: "coordinator" as const, proposals: [suggested, plain] };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [lead] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tasks[0].proposals, [suggested, plain]);

  const retired = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, proposals: [{ ...suggested, model: "gpt-5.6-luna" }] }] }));
  assert.equal(retired.ok, true);
  if (!retired.ok) return;
  assert.equal(retired.data.tasks[0].proposals?.[0]?.model, "gpt-6-luna");

  const broken = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, proposals: [{ ...suggested, brief: "fix it" }, plain, { ...plain, id: "p3", model: "gpt-0" }] }] }));
  assert.equal(broken.ok, true);
  if (!broken.ok) return;
  assert.equal(broken.hiddenTasks, 0, "the thread still loads");
  assert.deepEqual(broken.data.tasks[0].proposals, [plain], "only the suggestions it cannot read are dropped");
  assert.deepEqual(broken.data.tasks[0].messages, lead.messages);

  const unreadable = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, proposals: "none" }] }));
  assert.equal(unreadable.ok, true);
  if (!unreadable.ok) return;
  assert.equal(unreadable.data.tasks[0].proposals, undefined);
});

test("a muted coordinator stays muted across a reload, and a mute it cannot read is dropped", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const lead = { ...migrated.data.tasks[0], role: "coordinator" as const, muted: true as const };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [lead] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.tasks[0].muted, true);

  for (const muted of [false, "yes", 1]) {
    const loaded = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...lead, muted }] }));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.hiddenTasks, 0, "the thread still loads");
    assert.equal(loaded.data.tasks[0].muted, undefined);
    assert.deepEqual(loaded.data.tasks[0].messages, lead.messages);
  }
});

test("a thread's coordinator on another computer, and how far a coordinator heard its threads there and which were working, survive a reload, and what cannot be read is dropped", () => {
  const migrated = migrateV1ToV2(legacyValues());
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const remoteLead = { threadId: "lead-there", title: "Lead", computer: "Laptop" };
  const place = { computer: { id: "studio", name: "Studio" }, project: "app", worktree: true };
  const member = { ...migrated.data.tasks[0], remoteLead };
  const lead = { ...migrated.data.tasks[0], id: "lead", role: "coordinator" as const, remoteHeard: { far: 40 }, remoteWorking: { far: { computer: "studio", title: "Far work" } }, proposals: [{ id: "p1", title: "GPU", prompt: "Run them", place, from: "task-1", proposedAt: 1 }] };
  const parsed = parseThreadStore(serializeThreadStore({ ...migrated.data, tasks: [member, lead] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tasks[0].remoteLead, remoteLead);
  assert.deepEqual(parsed.data.tasks[1].remoteHeard, { far: 40 });
  assert.deepEqual(parsed.data.tasks[1].remoteWorking, { far: { computer: "studio", title: "Far work" } });
  assert.deepEqual(parsed.data.tasks[1].proposals?.[0]?.place, place, "a thread asked for elsewhere waits across a reload, with no brief when a thread under it asked");

  const broken = parseThreadStore(serializeUnchecked({ ...migrated.data, tasks: [{ ...member, remoteLead: { threadId: 7 } }, { ...lead, remoteHeard: { far: "late" }, remoteWorking: { far: { computer: 7, title: "Far work" } } }] }));
  assert.equal(broken.ok, true);
  if (!broken.ok) return;
  assert.equal(broken.hiddenTasks, 0, "both threads still load");
  assert.equal(broken.data.tasks[0].remoteLead, undefined);
  assert.equal(broken.data.tasks[1].remoteHeard, undefined);
  assert.equal(broken.data.tasks[1].remoteWorking, undefined);
  assert.deepEqual(broken.data.tasks[0].messages, member.messages);
});
