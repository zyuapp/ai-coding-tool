import assert from "node:assert/strict";
import { test } from "vitest";
import type { PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { MAX_COMPUTER_NAME } from "../../src/domain/computers.ts";
import { effectOf, workspace } from "./workspace-reducer-fixtures.mts";

const linux: PairedComputer = { id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1, state: null };

function named(overrides: Partial<WorkspaceState["computers"]> = {}): WorkspaceState {
  const state = workspace();
  return { ...state, computers: { ...state.computers, name: "zhuo-mac", paired: [linux], ...overrides } };
}

test("renaming this computer shows the name at once and hands it to the host; an empty name is the host's to fill in", () => {
  const renamed = reduce(named(), { type: "computers.rename", name: "  Studio  " });
  assert.equal(renamed.state.computers.name, "Studio");
  assert.deepEqual(effectOf(renamed, "computer.rename"), { type: "computer.rename", name: "Studio" });

  const cleared = reduce(renamed.state, { type: "computers.rename", name: "   " });
  assert.equal(cleared.state.computers.name, "Studio", "the machine's own name is the host's to announce");
  assert.deepEqual(effectOf(cleared, "computer.rename"), { type: "computer.rename", name: "" });

  const long = reduce(named(), { type: "computers.rename", name: "x".repeat(MAX_COMPUTER_NAME + 20) });
  assert.equal(long.state.computers.name.length, MAX_COMPUTER_NAME);
});

test("labelling a paired computer renames it here at once and hands the label to the host", () => {
  const labelled = reduce(named(), { type: "computers.label", id: "linux", name: " Build box " });
  assert.equal(labelled.state.computers.paired[0]?.name, "Build box");
  assert.deepEqual(effectOf(labelled, "computer.label"), { type: "computer.label", id: "linux", name: "Build box" });

  const cleared = reduce(labelled.state, { type: "computers.label", id: "linux", name: "" });
  assert.equal(cleared.state.computers.paired[0]?.name, "Build box", "what that computer calls itself is the host's to announce");
  assert.deepEqual(effectOf(cleared, "computer.label"), { type: "computer.label", id: "linux", name: "" });

  const before = named();
  const unknown = reduce(before, { type: "computers.label", id: "nobody", name: "Ghost" });
  assert.deepEqual(unknown.effects, []);
  assert.equal(unknown.state, before);
});

test("what the host announces is what the window shows, for this computer and the paired ones alike", () => {
  const state = reduce(named(), { type: "computers.rename", name: "Studio" }).state;
  const announced = reduce(state, { type: "computers.changed", name: "zhuo-mac", links: [{ id: "linux", name: "Build box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 }] }).state;
  assert.equal(announced.computers.name, "zhuo-mac");
  assert.equal(announced.computers.paired[0]?.name, "Build box");
});
