import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { liveTurn, tick } from "../../support/claude-session.mjs";

function childMessage(parent: string) {
  return {
    type: "assistant",
    uuid: "child-message",
    parent_tool_use_id: parent,
    message: {
      id: "child-message",
      model: "claude-sonnet",
      usage: { input_tokens: 100 },
      content: [{ type: "text", text: "Continuing the main task" }, { type: "tool_use", id: "child-tool", name: "Bash", input: { command: "npm test" } }],
    },
  };
}

for (const channel of ["main", "side"] as const) {
  test(`${channel} keeps unrecognized subagent output out of the conversation`, async () => {
    const emitted: ProviderEvent[] = [];
    const live = await liveTurn({ channel, emit: (event) => emitted.push(event) });
    live.capture.emit!(childMessage("inherited-parent"));
    await tick();
    assert.deepEqual(emitted, []);
    await live.end();
  });

  test(`${channel} does not open another run for subagent output after its answer`, async () => {
    let opened = 0;
    const live = await liveTurn({ channel, beginAgentTurn: () => { opened += 1; return null; } });
    live.capture.emit!({ type: "result", subtype: "success", is_error: false, result: "Answer" });
    await tick();
    live.capture.emit!(childMessage("inherited-parent"));
    live.capture.emit!({ type: "stream_event", parent_tool_use_id: "inherited-parent", event: { type: "message_start", message: { id: "child-stream" } } });
    await tick();
    assert.equal(opened, 0);
    await live.end();
  });
}

test("recognized subagent output stays in its subagent activity", async () => {
  const emitted: ProviderEvent[] = [];
  const live = await liveTurn({ emit: (event) => emitted.push(event) });
  live.capture.emit!({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "parent", subagent_type: "Explore", description: "Explore" });
  live.capture.emit!(childMessage("parent"));
  await tick();
  assert.deepEqual(emitted.map((event) => event.type), ["subagent.started", "subagent.activity", "subagent.activity"]);
  await live.end();
});
