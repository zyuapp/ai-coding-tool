import assert from "node:assert/strict";
import { test } from "vitest";
import type { PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { AGENT_ENGINES } from "../../src/domain/agent-engine.ts";
import { workspace } from "./workspace-reducer-fixtures.mts";

function paired(id: string, overrides: Partial<ComputerLink> = {}, state: WorkspaceState | null = workspace()): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, ...overrides, state };
}

function withComputers(computers: PairedComputer[]): WorkspaceState {
  const state = workspace();
  return { ...state, computers: { ...state.computers, name: "omarchy", paired: computers } };
}

test("a read from the Usage page asks every connected computer that knows how, and only that one", () => {
  const state = withComputers([
    paired("mac"),
    paired("away", { status: "offline" }),
    paired("old", { capabilities: ["command:task.send"] }),
  ]);
  const { effects } = reduce(state, { type: "usage.read", everywhere: true });
  assert.deepEqual(effects.filter((effect) => effect.type === "read-plan-usage").map((effect) => effect.engine), AGENT_ENGINES);
  assert.deepEqual(effects.filter((effect) => effect.type === "computer.forward"), [{ type: "computer.forward", id: "mac", inputs: [{ type: "usage.read" }] }]);
});

test("a read another computer asked for stays on this one, so two computers paired both ways never echo", () => {
  const { effects } = reduce(withComputers([paired("mac")]), { type: "usage.read" });
  assert.equal(effects.some((effect) => effect.type === "computer.forward"), false);
});

test("each paired computer's limits are drawn from the state it publishes", () => {
  const remote = workspace();
  const reported = {
    ...remote,
    planUsage: { read: 3, reading: [], dismissed: [], reports: { claude: { status: "available" as const, subscription: "max", windows: [] } } },
  };
  let state = withComputers([paired("mac", {}, remote), paired("old", { capabilities: [] })]);
  const before = deriveView(state).computerUsage;
  assert.deepEqual(before.map(({ id, usage, supported }) => ({ id, usage, supported })), [
    { id: "mac", usage: remote.planUsage, supported: true },
    { id: "old", usage: remote.planUsage, supported: false },
  ]);

  state = reduce(state, { type: "computer.state", id: "mac", state: { ...remote, prompts: { draft: "typing" } } }).state;
  assert.equal(deriveView(state).computerUsage, before, "a change elsewhere in its state keeps the page as it is");

  state = reduce(state, { type: "computer.state", id: "mac", state: reported }).state;
  assert.equal(deriveView(state).computerUsage[0]!.usage, reported.planUsage);
});

test("Usage opens on the computer whose thread is on screen, and its picker keeps to paired computers", () => {
  const usage = { type: "view.set-settings-open", open: true, section: "usage" } as const;
  const here = withComputers([paired("linux")]);
  const remote = { ...here, computers: { ...here.computers, active: "linux" } };
  const opened = reduce(remote, usage).state;
  assert.equal(deriveView(opened).usageComputer, "linux");

  const picked = reduce(opened, { type: "view.set-usage-computer", computerId: null }).state;
  assert.equal(deriveView(picked).usageComputer, null);
  assert.equal(reduce(picked, { type: "view.set-usage-computer", computerId: "gone" }).state, picked, "an unpaired computer cannot be picked");
  assert.equal(deriveView(reduce(picked, { type: "view.set-settings-open", open: true, section: "appearance" }).state).usageComputer, null, "another page leaves the pick alone");

  assert.equal(deriveView(reduce(here, usage).state).usageComputer, null);
});
