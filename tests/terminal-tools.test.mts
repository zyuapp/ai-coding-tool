import assert from "node:assert/strict";
import { test } from "vitest";
import { terminalTools } from "../src/main/agent/terminal-tools.mts";
import type { TerminalBridge } from "../src/main/agent/agent-provider.mts";
import type { TerminalRead, TerminalReadResult } from "../src/contracts/threads.js";
import type { TerminalSnapshot } from "../src/domain/terminal.js";

const snapshot = (overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  terminalId: "terminal-1",
  title: "ai-coding-tool",
  cwd: "/repo",
  status: "running",
  lines: ["$ yarn dev", "ready in 412 ms"],
  omitted: 0,
  ...overrides,
});

type FakeTerminalBridge = TerminalBridge & { calls: TerminalRead[] };

function fakeBridge(result: TerminalReadResult = { kind: "snapshot", snapshot: snapshot() }): FakeTerminalBridge {
  const calls: TerminalRead[] = [];
  return {
    calls,
    read: async (read) => { calls.push(read); return result; },
  };
}

type ToolResult = Awaited<ReturnType<ReturnType<typeof terminalTools>[number]["handler"]>>;
type TestTool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

function toolNamed(bridge: TerminalBridge, name: string): TestTool {
  const definition = terminalTools(bridge).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition as unknown as TestTool;
}

const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");

test("the terminal surface reads and never writes", () => {
  assert.deepEqual(terminalTools(fakeBridge()).map((entry) => entry.name), ["terminal_list", "terminal_read"]);
});

test("reading a terminal returns its lines under a heading naming where it runs", async () => {
  const bridge = fakeBridge();

  const read = await toolNamed(bridge, "terminal_read").handler({}, {});

  assert.deepEqual(bridge.calls, [{ op: "snapshot" }]);
  const text = textOf(read);
  assert.match(text, /ai-coding-tool — \/repo · running/);
  assert.match(text, /ready in 412 ms/);
});

test("a filtered read says how much it kept, and a truncated one says what it left out", async () => {
  const bridge = fakeBridge({ kind: "snapshot", snapshot: snapshot({ lines: ["error: missing token"], omitted: 240, matched: 3 }) });

  const read = await toolNamed(bridge, "terminal_read").handler({ lines: 50, match: "error" }, {});

  assert.deepEqual(bridge.calls, [{ op: "snapshot", lines: 50, match: "error" }]);
  const text = textOf(read);
  assert.match(text, /3 matching lines/);
  assert.match(text, /240 earlier lines not shown/);
});

test("a terminal that has exited reads as one, with the code it left behind", async () => {
  const bridge = fakeBridge({ kind: "snapshot", snapshot: snapshot({ status: "exited", exitCode: 130, lines: [] }) });

  const text = textOf(await toolNamed(bridge, "terminal_read").handler({ terminalId: "terminal-1" }, {}));

  assert.match(text, /exited \(130\)/);
  assert.match(text, /has printed nothing/);
});

test("listing terminals names each one, and says so plainly when there are none", async () => {
  const listed = await toolNamed(fakeBridge({
    kind: "terminals",
    terminals: [
      { id: "terminal-1", title: "ai-coding-tool", cwd: "/repo", taskId: "task-1", status: "running" },
      { id: "terminal-2", title: "logs", cwd: "/repo", taskId: null, status: "exited", exitCode: 0 },
    ],
  }), "terminal_list").handler({}, {});

  assert.match(textOf(listed), /ai-coding-tool \[terminal-1\] · \/repo · running/);
  assert.match(textOf(listed), /logs \[terminal-2\] · \/repo · exited \(0\)/);

  const empty = await toolNamed(fakeBridge({ kind: "no-terminal" }), "terminal_read").handler({}, {});
  assert.match(textOf(empty), /no terminal open/);
});

test("a bridge that fails answers as an error rather than throwing at the agent", async () => {
  const failing: TerminalBridge = { read: async () => { throw new Error("the window is not open"); } };

  const result = await toolNamed(failing, "terminal_read").handler({}, {});

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Terminal error: the window is not open/);
});
