import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { coordinationTools } from "../../../src/main/tools/coordination.mts";
import type { CoordinationBridge } from "../../../src/main/agent/agent-provider.mts";
import type { MemoryChange } from "../../../src/domain/coordination.js";

type FakeCoordinationBridge = CoordinationBridge & { changes: MemoryChange[] };

function fakeBridge(answer: (change: MemoryChange) => string = () => "Saved as [n1]. You and every thread you start from now on read it."): FakeCoordinationBridge {
  const changes: MemoryChange[] = [];
  return {
    changes,
    report: async () => ({ recorded: true, note: "" }),
    decide: async () => ({ recorded: true, note: "" }),
    remember: async (change) => {
      changes.push(change);
      return { note: answer(change) };
    },
  };
}

type ToolResult = Awaited<ReturnType<ReturnType<typeof coordinationTools>[number]["handler"]>>;
type TestTool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

function toolNamed(bridge: CoordinationBridge, name: string): TestTool {
  const definition = coordinationTools(bridge, "coordinator").find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition as unknown as TestTool;
}

const textOf = (result: ToolResult) => result.content.map((block) => block.text).join("");

test("a coordinator remembers, forgets and sets its purpose through its own memory", async () => {
  const bridge = fakeBridge();

  const saved = await toolNamed(bridge, "remember").handler({ text: "Propose threads before starting them" }, {});
  await toolNamed(bridge, "forget").handler({ noteId: "n3" }, {});
  await toolNamed(bridge, "set_purpose").handler({ purpose: "Ship the v2 reader" }, {});
  await toolNamed(bridge, "set_purpose").handler({ purpose: null }, {});

  assert.deepEqual(bridge.changes, [
    { kind: "remember", text: "Propose threads before starting them" },
    { kind: "forget", noteId: "n3" },
    { kind: "purpose", purpose: "Ship the v2 reader" },
    { kind: "purpose", purpose: null },
  ]);
  assert.equal(textOf(saved), "Saved as [n1]. You and every thread you start from now on read it.");
  assert.equal(saved.isError, undefined);
});

test("a memory change that cannot be made comes back as an error in its own words", async () => {
  const bridge: CoordinationBridge = { ...fakeBridge(), remember: async () => { throw new Error("Memory holds at most 30 notes. Forget one first."); } };

  const refused = await toolNamed(bridge, "remember").handler({ text: "One more" }, {});

  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), "Memory holds at most 30 notes. Forget one first.");
});

test("the tools hold notes and purposes to the limits the window writes them under", () => {
  const tools = coordinationTools(fakeBridge(), "coordinator");
  const accepts = (name: string, args: Record<string, unknown>) => z.object(tools.find((tool) => tool.name === name)!.input).safeParse(args).success;
  assert.equal(accepts("remember", { text: "x".repeat(501) }), false);
  assert.equal(accepts("remember", { text: "x".repeat(500) }), true);
  assert.equal(accepts("set_purpose", { purpose: "x".repeat(201) }), false);
  assert.equal(accepts("set_purpose", { purpose: null }), true);
});
