import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../src/main/agent/claude-agent-provider.mts";
import type { BackgroundReport } from "../src/contracts/ipc.ts";
import { input, liveQueryFactory, queryFactory, tick, turn, type LiveQueryCapture } from "./support/claude-session.mjs";

const liveCapture = (): LiveQueryCapture => ({ opens: 0, sent: [] });

/** The level the agent process reports its live tasks as: the whole set, every time it changes. */
const running = (type: string, ...ids: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: type, description: "npm run dev" })),
});

test("only background tasks that are processes of their own are reported, and the whole set each time", async () => {
  const reported: BackgroundReport[] = [];
  const provider = new ClaudeAgentProvider(queryFactory([
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "bash-1", task_type: "local_bash", description: "npm run dev" },
        { task_id: "agent-1", task_type: "local_agent", description: "Inspect the renderer" },
        { task_id: "watch-1", task_type: "monitor_ws", description: "Deploy events" },
      ],
    },
    running("local_bash", "bash-1"),
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  await provider.execute(input({ reportBackground: (report) => reported.push(report) }));
  assert.deepEqual(reported.map((report) => report.processes), [
    [],
    [{ id: "bash-1", kind: "shell", description: "npm run dev" }, { id: "watch-1", kind: "monitor", description: "Deploy events" }],
    [{ id: "bash-1", kind: "shell", description: "npm run dev" }],
    [],
  ], "a fresh session starts empty, because the agent process reports nothing at startup, and ending it empties the set again");
});

test("a background process keeps reporting between the turns of the session it runs under", async () => {
  const capture = liveCapture();
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const reported: BackgroundReport[] = [];
  const reportBackground = (report: BackgroundReport) => { reported.push(report); };
  const ids = () => reported.at(-1)?.processes.map((process) => process.id);

  await turn(capture, provider.execute(input({ reportBackground })),
    { type: "system", subtype: "init", session_id: "session-1" },
    running("local_bash", "bash-1"));

  capture.emit!(running("local_bash", "bash-1", "bash-2"));
  await tick();
  assert.deepEqual(ids(), ["bash-1", "bash-2"], "a process that starts with no turn going is still reported");

  const continuation = { provider: "claude", value: "session-1" } as const;
  await turn(capture, provider.execute(input({ continuation, reportBackground, prompt: "and again" })));
  assert.equal(capture.opens, 1);
  assert.deepEqual(ids(), ["bash-1", "bash-2"], "a second turn on the same session does not blank what is still running");

  provider.closeAll();
  await tick();
  assert.deepEqual(ids(), [], "the process the session took with it does not stay on the panel");
});

