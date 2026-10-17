import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { input, liveTurn, queryFactory, tick } from "../../support/claude-session.mjs";

test("each model response is counted once, subagents included", async () => {
  const emitted: ProviderEvent[] = [];
  const usage = (output: number) => ({ input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3_000, output_tokens: output });
  const reply = (id: string, model: string, output: number, parent: string | null = null) => ({
    type: "assistant",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    message: { id, model, usage: usage(output), content: [{ type: "text", text: `${id} says ${output}` }] },
  });
  const provider = new ClaudeAgentProvider(queryFactory([
    reply("response-1", "claude-sonnet", 5),
    reply("response-1", "claude-sonnet", 5),
    reply("response-1", "claude-sonnet", 40),
    reply("child-response", "claude-haiku", 7, "launch"),
    reply("response-2", "<synthetic>", 0),
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  assert.deepEqual(await provider.execute(input({ emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type === "spend"), [
    { type: "spend", tokens: 3_215 },
    { type: "spend", tokens: 35 },
    { type: "spend", tokens: 3_217 },
  ], "a block repeating its response adds nothing, a longer one adds only what it grew by, and a synthetic reply spent nothing");
});

test("only what a model spends while a run is attached is counted", async () => {
  const emitted: ProviderEvent[] = [];
  const response = (id: string, parent: string | null) => ({
    type: "assistant",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    message: { id, model: "claude-sonnet", usage: { input_tokens: 100, output_tokens: 20 }, content: [] },
  });
  const live = await liveTurn({ emit: (event) => emitted.push(event) });
  live.capture.emit!(response("during", null));
  live.capture.emit!({ type: "result", subtype: "success", is_error: false, result: "Answer" });
  await tick();
  live.capture.emit!(response("background-child", "launch"));
  live.capture.emit!(response("between-runs", null));
  await tick();
  await live.end();

  assert.deepEqual(emitted.filter((event) => event.type === "spend"), [{ type: "spend", tokens: 120 }], "work going on between runs has no run to count it");
});
