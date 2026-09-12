import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { SubagentReport } from "../../../src/domain/run.ts";
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

test("recognized subagent output is reported to the thread as that subagent's activity", async () => {
  const emitted: ProviderEvent[] = [];
  const reported: SubagentReport[] = [];
  const live = await liveTurn({ emit: (event) => emitted.push(event), reportSubagent: (report) => reported.push(report) });
  live.capture.emit!({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "parent", subagent_type: "Explore", description: "Explore" });
  live.capture.emit!(childMessage("parent"));
  await tick();
  assert.deepEqual(emitted, []);
  assert.deepEqual(reported.map((report) => report.type), ["subagent.started", "subagent.activity", "subagent.activity"]);
  assert.equal(reported[0].type === "subagent.started" && reported[0].sessionScoped, true);
  await live.end();
});

test("a subagent left running in the background reports to the thread after the turn's answer", async () => {
  let opened = 0;
  const reported: SubagentReport[] = [];
  const live = await liveTurn({ reportSubagent: (report) => reported.push(report), beginAgentTurn: () => { opened += 1; return null; } });
  live.capture.emit!({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "parent", subagent_type: "Explore", description: "Explore", is_backgrounded: true });
  live.capture.emit!({ type: "result", subtype: "success", is_error: false, result: "Answer" });
  await tick();
  live.capture.emit!(childMessage("parent"));
  live.capture.emit!({ type: "system", subtype: "task_progress", task_id: "child", description: "Explore", last_tool_name: "Read", usage: { total_tokens: 12 } });
  live.capture.emit!({ type: "system", subtype: "task_notification", task_id: "child", tool_use_id: "parent", status: "completed", output_file: "/tmp/out", summary: "Found it" });
  await tick();
  assert.equal(opened, 0);
  assert.deepEqual(reported.map((report) => report.type), ["subagent.started", "subagent.activity", "subagent.activity", "subagent.progress", "subagent.finished"]);
  assert.deepEqual(reported.at(-1), { type: "subagent.finished", id: "child", status: "completed", summary: "Found it" });
  await live.end();
});

test("the session ending stops the subagents it still holds", async () => {
  const reported: SubagentReport[] = [];
  const live = await liveTurn({ reportSubagent: (report) => reported.push(report) });
  live.capture.emit!({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "parent", subagent_type: "Explore", description: "Explore", is_backgrounded: true });
  await live.end();
  assert.deepEqual(reported.at(-1), { type: "subagent.finished", id: "child", status: "stopped", summary: "The session ended before this subagent finished." });
});
