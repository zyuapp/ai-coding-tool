import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPUTER_CAPABILITIES, supportsComputerCommand, supportsComputerQuery } from "../../src/contracts/computer-capabilities.ts";
import { isComputerClientMessage, isComputerQuery } from "../../src/contracts/computers.ts";
import { isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";

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
