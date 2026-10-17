import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { coordinationTools } from "../../../src/main/tools/coordination.mts";
import type { CoordinationBridge } from "../../../src/main/agent/agent-provider.mts";
import type { MemoryChange, ProposalRequest } from "../../../src/domain/coordination.js";

type FakeCoordinationBridge = CoordinationBridge & { changes: MemoryChange[]; proposed: ProposalRequest[][] };

function fakeBridge(answer: (change: MemoryChange) => string = () => "Saved as [n1]. You and every thread you start from now on read it."): FakeCoordinationBridge {
  const changes: MemoryChange[] = [];
  const proposed: ProposalRequest[][] = [];
  return {
    changes,
    proposed,
    report: async () => ({ recorded: true, note: "" }),
    decide: async () => ({ recorded: true, note: "" }),
    remember: async (change) => {
      changes.push(change);
      return { note: answer(change) };
    },
    propose: async (proposals) => {
      proposed.push(proposals);
      return { note: `Suggested ${proposals.length} threads.` };
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

test("a thread's report holds a summary the window can save it with", () => {
  const input = z.object(coordinationTools(fakeBridge(), "member").find((tool) => tool.name === "report_status")!.input);
  assert.equal(input.safeParse({ state: "done", summary: "PR #42" }).success, true);
  assert.equal(input.safeParse({ state: "done", summary: "x".repeat(501) }).success, false);
  assert.equal(input.safeParse({ state: "done", summary: " \n" }).success, false, "a blank summary is refused on its own field");
});

test("a coordinator's suggestions carry start_thread's fields and a title, with a brief only once it is whole", async () => {
  const bridge = fakeBridge();
  const answer = await toolNamed(bridge, "propose_threads").handler({
    threads: [
      { title: "Fix the login flake", prompt: "Make the login test pass reliably.", intent: "fix the flaky login test", doneWhen: "it passes 50 runs", delivers: "pull-request", worktree: true, model: "gpt-6-luna", effort: "low", role: "implementer" },
      { title: "Survey the docs", prompt: "List what the docs miss.", intent: "find gaps in the docs", doneWhen: "a list exists", project: "docs", worktreeId: "wt-1", worktree: true },
    ],
  }, {});

  assert.deepEqual(bridge.proposed, [[
    { title: "Fix the login flake", prompt: "Make the login test pass reliably.", brief: { intent: "fix the flaky login test", doneWhen: "it passes 50 runs", delivers: "pull-request" }, worktree: true, model: "gpt-6-luna", effort: "low", role: "implementer" },
    { title: "Survey the docs", prompt: "List what the docs miss.", project: "docs", worktreeId: "wt-1" },
  ]]);
  assert.equal(textOf(answer), "Suggested 2 threads.");
});

test("suggestions that cannot be kept come back as an error in their own words, and the tool holds them to the window's limits", async () => {
  const bridge: CoordinationBridge = { ...fakeBridge(), propose: async () => { throw new Error('Not suggested "Docs": A coordinator hands every thread it starts a brief.'); } };
  const refused = await toolNamed(bridge, "propose_threads").handler({ threads: [{ title: "Docs", prompt: "Write them." }] }, {});
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), 'Not suggested "Docs": A coordinator hands every thread it starts a brief.');

  const input = z.object(coordinationTools(fakeBridge(), "coordinator").find((tool) => tool.name === "propose_threads")!.input);
  const item = { title: "Docs", prompt: "Write them." };
  assert.equal(input.safeParse({ threads: [item] }).success, true);
  assert.equal(input.safeParse({ threads: [] }).success, false);
  assert.equal(input.safeParse({ threads: Array.from({ length: 13 }, () => item) }).success, false, "at most 12 wait at once");
  assert.equal(input.safeParse({ threads: [{ ...item, title: "x".repeat(121) }] }).success, false);
  assert.equal(input.safeParse({ threads: [{ ...item, model: "haiku" }] }).success, false, "a thread under a coordinator never runs on Haiku");
  assert.equal(input.safeParse({ threads: [{ prompt: "Write them." }] }).success, false, "every suggestion has a title");
  assert.equal(input.safeParse({ threads: [{ ...item, title: "  " }] }).success, false, "a blank title is refused on its own field");
  assert.equal(input.safeParse({ threads: [{ ...item, prompt: " \n" }] }).success, false, "a blank prompt is refused on its own field");
});
