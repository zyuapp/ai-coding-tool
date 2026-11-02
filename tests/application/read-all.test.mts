import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import { remoteUnreadCount, type PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

function paired(id: string, remote: WorkspaceState, overrides: Partial<PairedComputer> = {}): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, state: remote, ...overrides };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[], extra: Partial<WorkspaceState["computers"]> = {}): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers, ...extra } };
}

test("mark all read follows the sidebar's computer filter and leaves verdicts ranked", () => {
  const unread = (id: string) => task(id, { outcome: "finished", outcomeUnread: true, findings: [{ id: `${id}-f`, headline: "Found", at: 1 }] });
  const computers = ["one", "two"].map((id) => paired(id, workspace({ threads: [unread(id)] }), { capabilities: COMPUTER_CAPABILITIES }));
  for (const filter of ["this", "one", "all"] as const) {
    const state = withComputers(workspace({ threads: [unread("local"), task("quiet")] }), computers, { filter });
    const read = reduce(state, { type: "task.read-all" });
    const local = read.state.threads[0];
    assert.equal(local.outcomeUnread, filter === "one" ? true : undefined);
    assert.equal(local.outcome, "finished");
    assert.equal(local.findings?.[0].read, filter === "one" ? undefined : true);
    assert.equal(read.state.threads[1], state.threads[1]);
    assert.deepEqual(read.effects.filter((effect) => effect.type === "computer.forward").map((effect) => effect.id), filter === "this" ? [] : filter === "one" ? ["one"] : ["one", "two"]);
    assert.equal(remoteUnreadCount(state.computers), filter === "this" ? 0 : filter === "one" ? 1 : 2);
  }
  const forwarded = reduce(computers[0].state!, { type: "task.read-all", localOnly: true });
  assert.equal(forwarded.state.threads[0].outcomeUnread, undefined);
  assert.deepEqual(forwarded.effects.filter((effect) => effect.type === "computer.forward"), []);
});

test("mark all read skips computers with nothing unread and reports ones that cannot take it", () => {
  const remote = workspace({ threads: [task("remote", { outcome: "finished", outcomeUnread: true })] });
  const state = withComputers(workspace(), [paired("older", remote, { capabilities: [] }), paired("caught-up", workspace({ threads: [task("read", { outcome: "finished" })] }))]);
  const read = reduce(state, { type: "task.read-all" });
  assert.equal(read.result?.ok, false);
  assert.match(read.state.actionError!, /older:/);
  assert.deepEqual(read.effects.filter((effect) => effect.type === "computer.forward"), []);
});
