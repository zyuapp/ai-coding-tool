import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinationMembers, coordinationUsage, coordinationView } from "../../src/application/coordination.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

const lead = task("lead", { role: "coordinator", model: "opus", usage: { opus: 240_000 } });

function threads() {
  return [
    lead,
    task("tests", { parentId: "lead", model: "sonnet", usage: { sonnet: 1_500_000, opus: 100_000 } }),
    task("docs", { parentId: "lead", engine: "codex", model: "gpt-6.1-sol", usage: { "gpt-6.1-sol": 900_000 } }),
    task("merged", { parentId: "lead", resolvedAt: 5, usage: { sonnet: 364_220 } }),
    task("idle", { parentId: "lead" }),
    task("archived", { parentId: "lead", archivedAt: 9, usage: { opus: 7_000_000 } }),
    task("elsewhere", { usage: { opus: 50 } }),
  ];
}

test("a coordinator's usage adds up it and every thread under it, resolved ones too, by model and by thread", () => {
  const state = workspace({ threads: threads() });
  const usage = coordinationUsage(coordinationMembers(state, "lead"), lead);

  assert.ok(usage);
  assert.equal(usage.total, 3_104_220, "archived threads and threads under no coordinator do not count");
  assert.equal(usage.coordinator, 240_000);
  assert.deepEqual(usage.byModel, [
    { model: "sonnet", tokens: 1_864_220 },
    { model: "gpt-6.1-sol", tokens: 900_000 },
    { model: "opus", tokens: 340_000 },
  ]);
  assert.deepEqual(usage.byThread.map(({ thread, computer, tokens }) => [thread.id, computer, tokens]), [
    ["tests", null, 1_600_000],
    ["docs", null, 900_000],
    ["merged", null, 364_220],
  ], "most first, leaving out a thread that spent nothing");
});

test("a coordinator nothing was counted for shows no usage, and its view keeps its usage while nothing it counts moved", () => {
  assert.equal(coordinationUsage([], task("lead", { role: "coordinator" })), null);
  assert.equal(coordinationView(workspace({ threads: [task("lead", { role: "coordinator" })] }), task("lead", { role: "coordinator" }), new Set(), new Set()).usage, null);

  const before = workspace({ threads: threads() });
  const first = coordinationView(before, before.threads[0], new Set(), new Set());
  const talked = before.threads.map((thread) => thread.id === "docs" ? { ...thread, messages: [{ id: "m", kind: "user" as const, text: "go on", at: 30 }] } : thread);
  const unchanged = coordinationView(workspace({ threads: talked }), talked[0], new Set(), new Set(), undefined, first);
  assert.equal(unchanged.usage, first.usage, "a message moves no count");

  const spent = talked.map((thread) => thread.id === "docs" ? { ...thread, usage: { "gpt-6.1-sol": 900_500 } } : thread);
  const grown = coordinationView(workspace({ threads: spent }), spent[0], new Set(), new Set(), undefined, unchanged);
  assert.notEqual(grown.usage, first.usage);
  assert.equal(grown.usage?.total, 3_104_720);
});
