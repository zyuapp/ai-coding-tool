import assert from "node:assert/strict";
import { test } from "vitest";
import { applyWorkspacePatches, workspacePatches } from "../../src/application/workspace-patches.js";

test("streaming patches carry only changed text and preserve unrelated view references", () => {
  const messages = Array.from({ length: 1_000 }, (_, id) => ({ id, text: `History ${id}` }));
  const before = { threads: [{ id: "one", messages }, { id: "two", messages: [] }], projects: [{ id: "project" }], focused: true };
  const after = { ...before, threads: [{ ...before.threads[0], messages: [...messages, { id: 1_000, text: "Next" }] }, before.threads[1]] };
  const patches = workspacePatches(before, after);
  assert.ok(JSON.stringify(patches).length < 250);
  const applied = applyWorkspacePatches(before, structuredClone(patches));
  assert.deepEqual(applied, after);
  assert.equal(applied.projects, before.projects);
  assert.equal(applied.threads[1], before.threads[1]);
  assert.equal(applied.threads[0].messages[0], messages[0]);
});

test("workspace patches support removals, reordered arrays, sets and maps", () => {
  const before = { values: [1, 2, 3], record: { old: true }, set: new Set(["a"]), map: new Map([["a", 1]]) };
  const after = { values: [3, 1], record: {}, set: new Set(["b"]), map: new Map([["b", 2]]) };
  assert.deepEqual(applyWorkspacePatches(before, structuredClone(workspacePatches(before, after))), after);
  assert.deepEqual(before.values, [1, 2, 3]);
});

test("patch paths cannot write through prototypes", () => {
  assert.throws(() => applyWorkspacePatches({}, [{ path: ["__proto__", "polluted"], value: true }]), /Invalid/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.throws(() => applyWorkspacePatches({}, [{ path: ["constructor", "prototype", "polluted"], value: true }]), /Invalid/);
});

test("prepending and removing threads sends only the changed array slice", () => {
  let historyReads = 0;
  const threads = Array.from({ length: 2_000 }, (_, id) => ({
    id: `thread-${id}`,
    get messages() { historyReads++; return [{ text: "A long existing conversation" }]; },
  }));
  const added = { id: "new", messages: [{ text: "Hello" }] };
  const before = { threads };
  const after = { threads: [added, ...threads] };
  const patches = workspacePatches(before, after);
  assert.equal(historyReads, 0);
  assert.deepEqual(patches, [{ path: ["threads"], splice: { index: 0, deleteCount: 0, items: [added] } }]);
  assert.ok(JSON.stringify(patches).length < 200);
  const applied = applyWorkspacePatches(before, structuredClone(patches));
  assert.equal(applied.threads[1], before.threads[0]);
  assert.equal(applied.threads.at(-1), before.threads.at(-1));
  const removed = workspacePatches(applied, before);
  assert.deepEqual(removed, [{ path: ["threads"], splice: { index: 0, deleteCount: 1, items: [] } }]);
  assert.deepEqual(applyWorkspacePatches(applied, removed), before);
});

test("editing the final streaming message sends its changed field only", () => {
  const messages = Array.from({ length: 10_000 }, (_, id) => ({ id, text: "existing" }));
  const before = { messages };
  const after = { messages: [...messages.slice(0, -1), { ...messages.at(-1), text: "expanded response" }] };
  const patches = workspacePatches(before, after);
  assert.deepEqual(patches, [{ path: ["messages", 9_999, "text"], value: "expanded response" }]);
  const applied = applyWorkspacePatches(before, patches);
  assert.deepEqual(applied, after);
  assert.equal(applied.messages[0], before.messages[0]);
  assert.equal(before.messages.at(-1)?.text, "existing");
});

test("a large history load applies without spreading the transcript into call arguments", () => {
  const before: { messages: number[] } = { messages: [] };
  const after = { messages: Array.from({ length: 150_000 }, (_, index) => index) };
  assert.deepEqual(applyWorkspacePatches(before, workspacePatches(before, after)), after);
  assert.deepEqual(before.messages, []);
});

test("splice patches compose with field changes while preserving the original array", () => {
  const before = { rows: [{ text: "one" }, { text: "two" }, { text: "three" }] };
  const applied = applyWorkspacePatches(before, [
    { path: ["rows"], splice: { index: 1, deleteCount: 1, items: [{ text: "inserted" }, { text: "second" }] } },
    { path: ["rows", 3, "text"], value: "changed" },
    { path: ["rows"], splice: { index: 1, deleteCount: 2, items: [] } },
  ]);
  assert.deepEqual(applied.rows, [{ text: "one" }, { text: "changed" }]);
  assert.deepEqual(before.rows, [{ text: "one" }, { text: "two" }, { text: "three" }]);
  assert.equal(applied.rows[0], before.rows[0]);
});

test("own constructor and prototype fields remain valid dictionary keys", () => {
  const before = { dictionary: { constructor: { prototype: { enabled: false } } } };
  const after = { dictionary: { constructor: { prototype: { enabled: true } } } };
  assert.deepEqual(applyWorkspacePatches(before, workspacePatches(before, after)), after);
  assert.deepEqual(applyWorkspacePatches(after, workspacePatches(after, { dictionary: {} })), { dictionary: {} });
  assert.equal(before.dictionary.constructor.prototype.enabled, false);
});

test("adding an explicitly undefined field preserves its presence", () => {
  const before = { dictionary: {} };
  const after = { dictionary: { value: undefined } };
  const applied = applyWorkspacePatches(before, workspacePatches(before, after));
  assert.deepEqual(applied, after);
  assert.equal(Object.hasOwn(applied.dictionary, "value"), true);
});
