import assert from "node:assert/strict";
import { test } from "vitest";
import { createRemoteWorkspaceReader } from "../../src/application/remote-workspace.ts";
import { applyWorkspacePatches } from "../../src/application/workspace-patches.ts";
import { deriveView, emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import { task } from "./workspace-reducer-fixtures.mts";

test("older snapshots acquire defaults without changing the replica patches are based on", () => {
  const read = createRemoteWorkspaceReader();
  const wire = { threads: [task("old")], projects: [], currentId: "old", docks: { old: { open: true, panels: [], tab: "home" } } };
  const first = read(wire);
  assert.equal(deriveView(first).currentThread?.id, "old");
  assert.deepEqual(first.sideChats, []);
  assert.deepEqual(first.goals, {});
  assert.deepEqual(first.docks.old?.terminals, []);
  assert.equal(Object.hasOwn(wire, "goals"), false);
  const patched = applyWorkspacePatches<unknown>(wire, [
    { path: ["docks", "old", "terminals"], value: [] },
    { path: ["threads"], splice: { index: 1, deleteCount: 0, items: [task("next")] } },
  ]);
  const second = read(patched);
  assert.equal(second.threads[1]?.id, "next");
  assert.equal(second.sideChats, first.sideChats);
  assert.equal(second.goals, first.goals);
  const removed = read(applyWorkspacePatches(patched, [{ path: ["docks", "old", "terminals"], remove: true }]));
  assert.deepEqual(removed.docks.old?.terminals, []);
});

test("compatible snapshots and unchanged branches preserve references, including unfamiliar fields", () => {
  const read = createRemoteWorkspaceReader();
  const wire = { ...emptyWorkspaceState(), future: { enabled: true } };
  assert.equal(read(wire), wire);
  assert.equal(read(wire), wire);
  const moved = read({ ...wire, composerFocus: 2 });
  assert.equal(moved.threads, wire.threads);
  assert.equal(moved.docks, wire.docks);
  assert.equal((moved as typeof wire).future, wire.future);
  assert.throws(() => read({ ...wire, threads: null }), /collection/);
});


test("older collection records get required-field defaults while identity and unchanged records are preserved", () => {
  const read = createRemoteWorkspaceReader();
  const current = task("current");
  const old = { id: "old", engine: "claude", messages: [] };
  const wire = { threads: [old, current], projects: [{ id: "project", root: "/repo" }], sideChats: [{ id: "side", sourceThreadId: "old" }] };
  const normalized = read(wire);
  assert.equal(normalized.threads[0]?.executionPolicy, "confirm");
  assert.deepEqual(normalized.threads[0]?.lastChangeSnapshot, { files: [], capturedAt: 0 });
  assert.equal(normalized.sideChats[0]?.error, null);
  assert.equal(normalized.threads[1], current);
  assert.equal(read(wire), normalized);
  assert.equal(read({ ...wire, composerFocus: 1 }).threads, normalized.threads);
  assert.equal(Object.hasOwn(old, "executionPolicy"), false);
  assert.throws(() => read({ threads: [{ title: "missing identity" }] }), /identity/);
});

test("a newer build's model, effort, role or engine this one does not know never reaches the window", () => {
  const read = createRemoteWorkspaceReader();
  const known = task("known", { role: "coordinator", model: "opus", effort: "high" });
  const wire = { ...emptyWorkspaceState(), threads: [
    known,
    task("newer", { role: "designer", model: "opus-next", effort: "galaxy", outcome: "celebrated", executionPolicy: "yolo", threadModel: { model: "opus-next" } } as never),
    task("elsewhere", { engine: "gemini" } as never),
  ] };
  const { threads } = read(wire);
  assert.deepEqual(threads.map((thread) => thread.id), ["known", "newer"], "a thread on an engine this build does not know is not drawn");
  assert.equal(threads[0], known, "a thread with nothing unknown is handed on as it came");
  const newer = threads[1]!;
  assert.deepEqual([newer.role, newer.model, newer.effort, newer.outcome, newer.threadModel, newer.executionPolicy], [undefined, undefined, undefined, undefined, undefined, "confirm"]);
  assert.equal(read({ ...wire }).threads, threads, "and the list is read once while it does not move");
});
