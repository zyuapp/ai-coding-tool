import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPUTER_CAPABILITIES, supportsComputerCommand, supportsComputerQuery } from "../../src/contracts/computer-capabilities.ts";
import { isComputerClientMessage, isComputerQuery } from "../../src/contracts/computers.ts";
import { isExternalCommand, isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { isMobileCommand } from "../../src/contracts/mobile.ts";

test("dismiss-all scope is validated and advertised across command entry points", () => {
  for (const localOnly of [undefined, false, true, "true", 1, null]) {
    const command = { type: "task.dismiss-all", localOnly };
    const valid = localOnly === undefined || typeof localOnly === "boolean";
    assert.equal(isWorkspaceViewInput(command), valid);
    assert.equal(isMobileCommand(command), valid);
    assert.equal(isComputerClientMessage({ kind: "input", requestId: "dismiss", inputs: [command] }), valid);
  }
  assert.ok(supportsComputerCommand(COMPUTER_CAPABILITIES, { type: "task.dismiss-all", localOnly: true }));
});

test("actions and their optional fields are advertised from the validators for both engines", () => {
  for (const engine of ["claude", "codex"] as const) {
    const command = { type: "task.set-fast-mode", fastMode: true } as const;
    assert.ok(isWorkspaceViewInput(command));
    assert.ok(supportsComputerCommand(COMPUTER_CAPABILITIES, command));
    const query = { kind: "commands", workspaceId: "ws", engine } as const;
    assert.ok(isComputerQuery(query));
    assert.ok(supportsComputerQuery(COMPUTER_CAPABILITIES, query));
  }
  const older = COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:role");
  assert.ok(supportsComputerCommand(older, { type: "task.send", text: "hello" }));
  assert.equal(supportsComputerCommand(older, { type: "task.send", text: "hello", role: "reviewer" }), false);
});

test("unknown names are harmless, absent discovery is best effort, and an empty advertised list supports nothing", () => {
  const command = { type: "task.rename", taskId: "t", title: "new" } as const;
  assert.ok(supportsComputerCommand([...COMPUTER_CAPABILITIES, "future:feature"], command));
  assert.ok(supportsComputerCommand(undefined, command));
  assert.equal(supportsComputerCommand([], command), false);
  assert.equal(supportsComputerCommand(["command:task.rename"], command), false);
  assert.equal(isComputerClientMessage({ kind: "input", requestId: "id", inputs: [{ type: "action.failed", message: "injected" }] }), false);
});

test("a computer says it takes threads under a coordinator elsewhere, and reads their pull requests, only by name", () => {
  for (const name of ["command:task.send:lead", "command:task.send:memory", "command:pull-request.read-member", "command:proposal.start:place"]) assert.ok(COMPUTER_CAPABILITIES.includes(name), name);
  const lead = { threadId: "lead", title: "Lead", computer: "Mac" };
  assert.ok(isWorkspaceViewInput({ type: "task.send", text: "Go", lead, memory: "The coordinator's purpose: Ship" }));
  assert.equal(isWorkspaceViewInput({ type: "task.send", text: "Go", lead: { ...lead, threadId: "" } }), false);
  assert.ok(isWorkspaceViewInput({ type: "task.send", text: "Go", lead: { ...lead, proposalId: "p1" } }));
  assert.equal(isWorkspaceViewInput({ type: "task.send", text: "Go", lead: { ...lead, proposalId: "" } }), false);
  assert.equal(isWorkspaceViewInput({ type: "task.send", text: "Go", memory: "x".repeat(64_001) }), false);
  assert.equal(isExternalCommand({ type: "task.send", text: "Go", lead }), false, "only the window says which coordinator a thread works under");
  assert.equal(isExternalCommand({ type: "task.send", text: "Go", memory: "Remember" }), false);
});
