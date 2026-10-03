import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { TerminalUpdate } from "../../src/domain/terminal.ts";

vi.mock("node:module", async (original) => ({
  ...await original<typeof import("node:module")>(),
  createRequire: () => () => { throw new Error("The terminal is missing."); },
}));

const { startTerminal, startTerminalHost, stopTerminalHost, terminalSnapshot } = await import("../../src/main/terminal-host.ts");

test("a terminal whose modules fail to load reports that it exited, and holds no session", async (t) => {
  const updates: TerminalUpdate[] = [];
  startTerminalHost({ onData: () => undefined, onUpdate: (update) => { updates.push(update); } });
  t.onTestFinished(() => stopTerminalHost());
  assert.doesNotThrow(() => startTerminal("broken", process.cwd()));
  assert.deepEqual(updates, [{ terminalId: "broken", status: "exited", error: "The terminal is missing." }]);
  assert.equal(await terminalSnapshot("broken"), null);
});
