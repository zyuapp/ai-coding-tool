import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../src/main/agent/claude-agent-provider.mts";
import { reduce } from "../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../src/application/workspace-state.ts";
import type { AgentTurn, ProviderEvent, ProviderResult } from "../src/main/agent/agent-provider.mts";
import type { Task } from "../src/domain/task.ts";
import { input, liveQueryFactory, liveTurn, tick, turn, type LiveQueryCapture } from "./support/claude-session.mjs";

function task(id: string): Task {
  return { id, title: id, executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

test("what the agent says between runs opens a turn of its own", async () => {
  const capture: LiveQueryCapture = { opens: 0, sent: [] };
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const emitted: ProviderEvent[] = [];
  const turns: ProviderResult[] = [];
  const agentTurn = {
    emit: (event) => emitted.push(event),
    authorize: async () => "allow",
    end: (result) => turns.push(result),
  } satisfies AgentTurn;

  await turn(capture, provider.execute(input({ beginAgentTurn: () => agentTurn })));
  capture.emit!({ type: "assistant", uuid: "u-1", message: { id: "m-1", model: "claude-opus-5", content: [{ type: "text", text: "The workflow finished." }], usage: { input_tokens: 5 } } } as unknown as SDKMessage);
  capture.emit!({ type: "result", subtype: "success", is_error: false, result: "The workflow finished." } as SDKMessage);
  await tick();

  assert.deepEqual(emitted.filter((event) => event.type === "assistant"), [{ type: "assistant", messageId: "u-1", text: "The workflow finished." }]);
  assert.deepEqual(turns, [{ status: "succeeded" }], "the turn ends on its own result");
  provider.closeAll();
});

test("a tool call from work that outlived its run is asked, not refused", async () => {
  const asked: string[] = [];
  const agentTurn = {
    emit: () => {},
    authorize: async (intent) => { asked.push(intent.name); return "deny"; },
    end: () => {},
  } satisfies AgentTurn;

  const session = await liveTurn({ beginAgentTurn: () => agentTurn });
  await session.end();

  const decision = await session.canUseTool("Write", { file_path: "/tmp/project/notes.md" }, { toolUseID: "t-1", signal: new AbortController().signal, requestId: "r-1" });
  assert.deepEqual(asked, ["Write"]);
  assert.ok(decision);
  assert.equal(decision.behavior, "deny", "the user's answer stands, rather than the run being gone");

  const noRun = await liveTurn({ beginAgentTurn: () => null });
  await noRun.end();
  const refused = await noRun.canUseTool("Write", { file_path: "/tmp/project/notes.md" }, { toolUseID: "t-2", signal: new AbortController().signal, requestId: "r-2" });
  assert.ok(refused?.behavior === "deny");
  assert.equal(refused.message, "The run this call belongs to is over.");
});

test("a turn the agent starts itself is taken on by the thread, and read there", () => {
  const idle = workspace({ tasks: [task("task-a")], currentId: "task-b", sideChats: [] });
  const opened = reduce(idle, { type: "run.event", event: { type: "run.started", taskId: "task-a", runId: "run-agent", sequence: 1, agentInitiated: true } });
  assert.equal(opened.state.activeRuns["task-a"]?.runId, "run-agent");

  const said = reduce(opened.state, { type: "run.event", event: { type: "assistant.delta", taskId: "task-a", runId: "run-agent", sequence: 2, messageId: "m-1", text: "The workflow finished." } });
  assert.equal(said.state.tasks.find((item) => item.id === "task-a")?.messages.at(-1)?.text, "The workflow finished.");

  const ended = reduce(said.state, { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-agent", sequence: 3, status: "succeeded" } });
  const settledTask = ended.state.tasks.find((item) => item.id === "task-a");
  assert.ok(settledTask);
  assert.equal(ended.state.activeRuns["task-a"], undefined);
  assert.equal(settledTask.outcomeUnread, true, "a thread the user is not on says it has something to read");

  const stranger = reduce(idle, { type: "run.event", event: { type: "run.started", taskId: "task-gone", runId: "run-agent", sequence: 1, agentInitiated: true } });
  assert.deepEqual(stranger.state, idle, "a thread that is gone takes on nothing");
  const unasked = reduce(idle, { type: "run.event", event: { type: "run.started", taskId: "task-a", runId: "run-agent", sequence: 1 } });
  assert.deepEqual(unasked.state, idle, "a run nobody opened is not taken on by itself");
});
