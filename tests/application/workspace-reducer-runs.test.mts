import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { AutomationFire } from "../../src/contracts/ipc.ts";
import { sentPrompts } from "../../src/domain/task.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { task, workspace, activeRun, automation, effectAt, required, correlatedRunEvent, run, running, send, type RunEventPayload } from "./workspace-reducer-fixtures.mts";

test("a scheduled run declines when the task is archived, gone, or already running", () => {
  const fire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2 };
  const declined = [
    workspace({ tasks: [] }),
    workspace({ tasks: [task("task-a", { archivedAt: 5 })] }),
    workspace({ tasks: [task("task-a")], activeRuns: { "task-a": activeRun("task-a", "other") } }),
  ];
  for (const state of declined) {
    assert.deepEqual(reduce(state, { type: "automation.fired", fire }).effects, [
      { type: "automation.ack", ack: { automationId: "automation-1", runId: "run-1", started: false } },
    ]);
  }
});

test("a scheduled run starts with its own framing and acknowledges the tick", () => {
  const state = workspace({ tasks: [task("task-a")] });
  const fire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, policy: "autonomous" } satisfies AutomationFire;
  const pending = reduce(state, { type: "automation.fired", fire });
  const started = reduce(pending.state, { type: "run.resolved", pendingId: effectAt(pending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const start = effectAt(started, "start-run");
  const acknowledged = effectAt(started, "automation.ack", 1);
  assert.equal(start.command.runId, "run-1");
  assert.equal(start.command.policy, "autonomous");
  assert.match(start.command.prompt, /automated run #2/);
  assert.deepEqual(acknowledged, { type: "automation.ack", ack: { automationId: "automation-1", runId: "run-1", started: true } });
  assert.equal(started.state.tasks[0].messages[0].detail, "Automation run #2");
  assert.deepEqual(sentPrompts(started.state.tasks[0].messages), [], "a scheduled prompt is not one the composer offers back");
});

test("manual Sol compaction reuses the run lifecycle without becoming a task run", () => {
  const state = workspace({
    tasks: [task("task-a", {
      engine: "codex",
      model: "gpt-5.6-sol",
      continuation: { provider: "codex", value: "thread-1" },
      continuationStatus: "available",
      contextUsage: { tokens: 125_000, limit: 272_000, model: "gpt-5.6-sol" },
      outcome: "finished",
      runEndedAt: 5,
    })],
    currentId: "task-a",
  });
  const pending = reduce(state, { type: "run.compact" });
  const resolved = reduce(pending.state, {
    type: "run.resolved",
    pendingId: effectAt(pending, "resolve-run-workspace").pendingId,
    workspace: { id: "projectless", kind: "projectless", root: "/tmp" },
  });
  const command = effectAt(resolved, "start-run").command;

  assert.equal(command.prompt, "");
  assert.deepEqual(command.operation, { type: "compact", preTokens: 125_000 });
  assert.equal(resolved.state.activeRuns["task-a"].operation, "compact");
  assert.deepEqual(resolved.state.tasks[0].messages, [], "compaction sends no user message");

  const compacting = reduce(resolved.state, correlatedRunEvent("task-a", command.runId, 1, { type: "context.compaction-status", compacting: true }));
  assert.equal(deriveView(compacting.state).compacting, true, "the existing Compacting messages status is used");
  const compacted = reduce(compacting.state, correlatedRunEvent("task-a", command.runId, 2, { type: "context.compacted", trigger: "manual", preTokens: 125_000 }));
  const idle = reduce(compacted.state, correlatedRunEvent("task-a", command.runId, 3, { type: "context.compaction-status", compacting: false }));
  const finished = reduce(idle.state, correlatedRunEvent("task-a", command.runId, 4, { type: "run.status", status: "succeeded" }));

  assert.equal(finished.state.tasks[0].messages[0].text, "Context manual-compacted at 125,000 tokens.");
  assert.equal(finished.state.tasks[0].outcome, "finished", "the prior task verdict survives context maintenance");
  assert.equal(finished.state.tasks[0].runEndedAt, 5);
  assert.equal(finished.state.activeRuns["task-a"], undefined);
  assert.deepEqual(finished.effects, [], "context maintenance neither announces a finished task nor refreshes its checkout");

  const terra = { ...state, tasks: [{ ...state.tasks[0], model: "gpt-5.6-terra" as const }] };
  assert.deepEqual(reduce(terra, { type: "run.compact" }).effects, [], "the command stays specific to Sol");
});

test("a run that settles off screen flags its thread and refreshes its project", () => {
  const state = workspace({
    tasks: [task("task-a", { projectId: "project-1" }), task("task-b")],
    projects: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }],
    activeRuns: { "task-a": activeRun("task-a", "run-1") },
    focused: false,
    currentId: "task-b",
  });

  const settled = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-1", sequence: 1, status: "succeeded" } });
  assert.equal(settled.state.tasks[0].outcome, "finished");
  assert.deepEqual(settled.effects, [{ type: "refresh-environment", workspaceId: "workspace-1", taskId: "task-a", runId: "run-1" }, { type: "announce-thread", notice: { taskId: "task-a", title: "task-a", headline: "The run finished." } }]);

  assert.equal(settled.state.tasks[0].outcomeUnread, true);

  const opened = reduce(settled.state, { type: "task.select", taskId: "task-a" });
  assert.equal(opened.state.tasks[0].outcomeUnread, undefined, "opening the thread takes the mark off");
  assert.equal(opened.state.tasks[0].outcome, "finished", "but the verdict keeps its place in Priority");
  assert.deepEqual(deriveView(opened.state).activityTasks.priority.map((item) => item.id), ["task-a"]);
});

test("a dot can be dismissed without opening the thread it is on", () => {
  const state = workspace({ tasks: [task("task-a", { outcome: "finished" }), task("task-b")], currentId: "task-b" });

  const dismissed = reduce(state, { type: "task.dismiss", taskId: "task-a" });
  assert.equal(dismissed.state.tasks[0].outcome, undefined);
  assert.equal(dismissed.state.currentId, "task-b", "and dismissing does not carry the user there");
});

test("one dismissal takes the dot off every thread carrying one", () => {
  const state = workspace({
    tasks: [
      task("done", { outcome: "finished" }),
      task("broke", { outcome: "failed" }),
      task("quiet"),
    ],
  });

  const { state: cleared } = reduce(state, { type: "task.dismiss-all" });

  assert.deepEqual(cleared.tasks.map((item) => item.outcome), [undefined, undefined, undefined]);
  assert.equal(reduce(cleared, { type: "task.dismiss-all" }).state, cleared, "a second pass has nothing left to take");
});

test("the thread on screen ranks into priority unmarked, having been read as it settled", () => {
  const watched = workspace({
    tasks: [task("task-a"), task("task-b")],
    activeRuns: { "task-a": activeRun("task-a", "run-1") },
    focused: true,
    currentId: "task-a",
  });
  const settle = { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-1", sequence: 1, status: "succeeded" } } satisfies WorkspaceInput;

  const { state: next } = reduce(watched, settle);
  assert.equal(next.tasks[0].outcome, "finished");
  assert.equal(next.tasks[0].outcomeUnread, undefined, "the user watched it end, so nothing marks it");
  assert.deepEqual(deriveView(next).activityTasks.priority.map((item) => item.id), ["task-a"], "and it still leaves the running list for priority");

  const behind = reduce({ ...watched, focused: false }, settle).state;
  assert.equal(behind.tasks[0].outcomeUnread, undefined, "an unfocused window changes nothing; the thread is still the one on screen");

  const elsewhere = reduce({ ...watched, currentId: "task-b" }, settle).state;
  assert.equal(elsewhere.tasks[0].outcomeUnread, true, "a thread the user is not on is marked");
});

test("selecting a thread takes its mark off and leaves it ranked", () => {
  const state = workspace({ tasks: [task("task-a", { outcome: "failed", outcomeUnread: true }), task("task-b")], currentId: "task-b" });

  const { state: next } = reduce(state, { type: "task.select", taskId: "task-a" });

  assert.equal(next.tasks[0].outcomeUnread, undefined);
  assert.deepEqual(deriveView(next).activityTasks.priority.map((item) => item.id), ["task-a"], "reading is not filing it away");

  const filed = reduce(next, { type: "task.dismiss", taskId: "task-a" });
  assert.equal(filed.state.tasks[0].outcome, undefined);
  assert.deepEqual(deriveView(filed.state).activityTasks.priority, []);
});

test("a run the user stops keeps its thread in priority", () => {
  const state = workspace({
    tasks: [task("task-a", { outcome: "finished" }), task("task-b")],
    currentId: "task-a",
  });
  const sending = reduce(state, { type: "view.set-prompt", prompt: "Try again" });
  const sent = reduce(sending.state, { type: "task.send", attachments: [] });
  const started = reduce(sent.state, { type: "run.resolved", pendingId: effectAt(sent, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.deepEqual(deriveView(started.state).activityTasks.running.map((item) => item.id), ["task-a"]);

  const runId = effectAt(started, "start-run").command.runId;
  const cancelling = reduce(started.state, { type: "run.cancel" });
  assert.deepEqual(cancelling.effects, [{ type: "send-run-command", command: { type: "cancel", taskId: "task-a", runId } }]);
  const stopped = reduce(cancelling.state, correlatedRunEvent("task-a", runId, 1, { type: "run.status", status: "cancelled" }));

  assert.equal(stopped.state.tasks[0].outcome, "stopped");
  assert.equal(stopped.state.tasks[0].outcomeUnread, undefined, "the user stopped it themselves, so nothing marks it");
  const view = deriveView(stopped.state);
  assert.deepEqual(view.activityTasks.priority.map((item) => item.id), ["task-a"], "it waits on the user rather than dropping into Threads");
  assert.deepEqual(view.activityTasks.running, []);
  assert.deepEqual(stopped.effects.filter((effect) => effect.type === "announce-thread"), [], "and a stop the user asked for says nothing on the desktop");

  const filed = reduce(stopped.state, { type: "task.dismiss", taskId: "task-a" });
  assert.equal(filed.state.tasks[0].outcome, undefined);
  assert.deepEqual(deriveView(filed.state).activityTasks.priority, []);
});

test("a run ending under an archived thread leaves no verdict on it", () => {
  const state = workspace({
    tasks: [task("task-a", { archivedAt: 5 }), task("task-b")],
    activeRuns: { "task-a": activeRun("task-a", "run-1") },
    currentId: "task-b",
  });

  for (const status of ["cancelled", "succeeded", "failed"] as const) {
    const settled = reduce(state, correlatedRunEvent("task-a", "run-1", 1, { type: "run.status", status }));
    assert.equal(settled.state.tasks[0].outcome, undefined, `${status}: a thread already filed away is past ranking`);
    assert.equal(settled.state.tasks[0].outcomeUnread, undefined, `${status}: and it never marks the app icon`);
  }
});

test("a new run supersedes the verdict of the one before it", () => {
  const state = run(workspace({ tasks: [task("task-a", { outcome: "finished" })], currentId: "task-a" }), [
    { type: "view.set-prompt", prompt: "Try again" },
  ]);
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(started.state.tasks[0].outcome, undefined, "the old verdict does not outlive the run it described");
  const view = deriveView(started.state);
  assert.deepEqual(view.activityTasks.priority, [], "a working thread is never in Priority");
  assert.deepEqual(view.activityTasks.running.map((item) => item.id), ["task-a"]);
});

test("a thread blocked on an approval leads until the user answers, then goes back to running", () => {
  const state = run(workspace(), [{ type: "view.set-prompt", prompt: "Look around" }]);
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { taskId, runId } = effectAt(started, "start-run").command;

  const asking = run(started.state, [
    { type: "run.event", event: { type: "approval.requested", taskId, runId, sequence: 1, approvalId: "approval-1", title: "Run a command", description: "ls", intent: { toolId: "tool-1", name: "Bash", input: { command: "ls" } } } },
    { type: "run.event", event: { type: "run.status", taskId, runId, sequence: 2, status: "awaiting-approval" } },
  ]);
  assert.equal(asking.tasks[0].outcome, undefined, "asking is live state, not a verdict written on the thread");
  assert.deepEqual(deriveView(asking).blockedTaskIds, new Set([taskId]));
  assert.deepEqual(deriveView(asking).activityTasks.priority.map((item) => item.id), [taskId]);
  assert.deepEqual(deriveView(asking).activityTasks.running, []);

  const dismissed = reduce(asking, { type: "task.dismiss", taskId });
  assert.deepEqual(deriveView(dismissed.state).activityTasks.priority.map((item) => item.id), [taskId], "a question cannot be dismissed away");

  const answered = run(reduce(asking, { type: "run.decide", allow: true }).state, [
    { type: "run.event", event: { type: "run.status", taskId, runId, sequence: 3, status: "running" } },
  ]);
  assert.deepEqual(deriveView(answered).blockedTaskIds, new Set());
  assert.deepEqual(deriveView(answered).activityTasks.priority, [], "the answered thread leaves no dot behind");
  assert.deepEqual(deriveView(answered).activityTasks.running.map((item) => item.id), [taskId]);
});

test("every visible thread lands in exactly one activity section", () => {
  const state = workspace({
    tasks: [
      task("idle"),
      task("settled", { outcome: "finished" }),
      task("seen", { outcome: "failed" }),
      task("working", { outcome: "finished" }),
      task("asking", { outcome: "failed" }),
      task("archived", { outcome: "finished", archivedAt: 2 }),
    ],
    activeRuns: {
      working: activeRun("working", "run-1"),
      asking: activeRun("asking", "run-2", { status: "awaiting-approval" }),
    },
  });

  const { priority, running, threads } = deriveView(state).activityTasks;
  const placed = [...priority, ...running, ...threads].map((item) => item.id);
  assert.deepEqual(placed.slice().sort(), ["asking", "idle", "seen", "settled", "working"], "every unarchived thread appears once");
  assert.deepEqual(priority.map((item) => item.id).sort(), ["asking", "seen", "settled"]);
  assert.deepEqual(running.map((item) => item.id), ["working"]);
  assert.deepEqual(threads.map((item) => item.id), ["idle"]);
});

test("a streaming tail shows outside the task, so nothing half-written is ever stored", () => {
  const state = running();
  const event = (sequence: number, extra: RunEventPayload) => correlatedRunEvent("task-a", "run-a", sequence, extra);

  const streaming = run(state, [
    event(1, { type: "assistant.tail", messageId: "message-1", text: "The first thing" }),
    event(2, { type: "assistant.tail", messageId: "message-1", text: "The first thing to check" }),
  ]);
  assert.deepEqual(streaming.streamingTails["task-a"], { messageId: "message-1", text: "The first thing to check" });
  assert.deepEqual(streaming.tasks[0].messages, [], "a tail never becomes a message");
  assert.equal(streaming.tasks[0], state.tasks[0], "the task is untouched, so persistence has nothing to write");

  const committed = reduce(streaming, event(3, { type: "assistant.delta", messageId: "message-1", text: "The first thing to check is the reducer.\n\n", append: true })).state;
  assert.equal(committed.streamingTails["task-a"], undefined, "the committed block replaces what the tail was standing in for");
  assert.equal(committed.tasks[0].messages[0].text, "The first thing to check is the reducer.\n\n");

  const resumed = reduce(committed, event(4, { type: "assistant.tail", messageId: "message-1", text: "Then the" })).state;
  assert.deepEqual(resumed.streamingTails["task-a"], { messageId: "message-1", text: "Then the" });

  const finished = reduce(resumed, event(5, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(finished.streamingTails, {}, "a finished run leaves no tail behind");
});

test("an emptied tail clears rather than rendering nothing, and a new run starts clean", () => {
  const state = running();
  const event = (sequence: number, extra: RunEventPayload) => correlatedRunEvent("task-a", "run-a", sequence, extra);

  const cleared = run(state, [
    event(1, { type: "assistant.tail", messageId: "message-1", text: "Half a sen" }),
    event(2, { type: "assistant.tail", messageId: "message-1", text: "" }),
  ]);
  assert.deepEqual(cleared.streamingTails, {});

  const stale = run(state, [event(1, { type: "assistant.tail", messageId: "message-1", text: "Interrupted" })]);
  const restarted = reduce(stale, event(2, { type: "run.started" })).state;
  assert.deepEqual(restarted.streamingTails, {}, "a new run never inherits the previous run's tail");
});

test("a side chat streams its own tail without disturbing the main thread", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { runId } = effectAt(resolved, "start-run").command;
  const started = resolved.state;

  const streaming = reduce(started, { type: "run.event", event: { type: "assistant.tail", taskId: "chat-1", runId, sequence: 1, messageId: "message-1", text: "It reduces" } }).state;
  assert.deepEqual(streaming.streamingTails["chat-1"], { messageId: "message-1", text: "It reduces" });
  assert.equal(streaming.streamingTails["main-task"], undefined);
  assert.equal(required(required(deriveView(streaming).sideChats[0]).streamingTail).text, "It reduces");
});

test("a side chat answers its own approval without the main thread in the way", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { runId } = effectAt(resolved, "start-run").command;

  const asking = run(resolved.state, [
    { type: "run.event", event: { type: "approval.requested", taskId: "chat-1", runId, sequence: 1, approvalId: "approval-1", title: "Run a command", description: "ls", intent: { toolId: "tool-1", name: "Bash", input: { command: "ls" } } } },
    { type: "run.event", event: { type: "run.status", taskId: "chat-1", runId, sequence: 2, status: "awaiting-approval" } },
  ]);
  const view = deriveView(asking);
  assert.equal(required(required(view.sideChats[0]).approval).approvalId, "approval-1");
  assert.equal(view.approval, undefined, "the main thread shows nothing");

  assert.deepEqual(reduce(asking, { type: "run.decide", allow: true }).effects, [], "the main thread cannot answer for the side chat");

  const decided = reduce(asking, { type: "run.decide", allow: true, taskId: "chat-1" });
  assert.deepEqual(decided.effects, [{ type: "send-run-command", command: { type: "approval", taskId: "chat-1", runId, approvalId: "approval-1", allow: true } }]);
  assert.equal(required(deriveView(decided.state).sideChats[0]).approval, undefined);
});

test("stopping a background process marks the row and asks the session, once", () => {
  const running = { "task-a": [{ id: "bash-1", kind: "shell" as const, description: "npm run dev" }] };
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a", activeRuns: { "task-a": activeRun("task-a", "run-a") }, backgroundProcesses: running });

  const stopping = reduce(state, { type: "run.stop-process", processId: "bash-1" });
  assert.deepEqual(stopping.effects, [
    { type: "send-run-command", command: { type: "stop-process", taskId: "task-a", processId: "bash-1" } },
  ]);
  assert.equal(stopping.state.backgroundProcesses["task-a"][0].stopping, true);
  assert.deepEqual(deriveView(stopping.state).backgroundProcesses, stopping.state.backgroundProcesses["task-a"]);

  assert.deepEqual(reduce(stopping.state, { type: "run.stop-process", processId: "bash-1" }).effects, [], "a stop already on its way is not repeated");
  assert.deepEqual(reduce(state, { type: "run.stop-process", processId: "ghost" }).effects, []);
  assert.deepEqual(reduce(workspace({ tasks: [task("task-a")], currentId: "task-a" }), { type: "run.stop-process", processId: "bash-1" }).effects, [], "nothing running, nothing to stop");

  const shell = { id: "bash-1", kind: "shell" as const, description: "npm run dev" };
  const idle = workspace({ tasks: [task("task-a")], currentId: "task-a" });
  const started = reduce(idle, { type: "thread.event", event: { type: "background.changed", taskId: "task-a", processes: [shell] } });
  assert.deepEqual(deriveView(started.state).backgroundProcesses, [shell], "a process lands on its thread with no run to carry it");

  const stopped = reduce(started.state, { type: "run.stop-process", processId: "bash-1" });
  assert.deepEqual(stopped.effects, [
    { type: "send-run-command", command: { type: "stop-process", taskId: "task-a", processId: "bash-1" } },
  ], "a process the run left behind is still stoppable once the run has ended");
  assert.equal(stopped.state.backgroundProcesses["task-a"][0].stopping, true);

  const gone = reduce(stopped.state, { type: "thread.event", event: { type: "background.changed", taskId: "task-a", processes: [] } });
  assert.deepEqual(deriveView(gone.state).backgroundProcesses, []);
});

test("a workflow's frames land on its thread with no run to carry them", () => {
  const idle = workspace({ tasks: [task("task-a")], currentId: "task-a" });
  const started = reduce(idle, {
    type: "thread.event",
    event: { type: "workflow.started", taskId: "task-a", id: "wf-1", name: "review-changes", description: "Review changed files" },
  });
  assert.equal(started.state.workflows["task-a"][0].status, "running");

  const finished = reduce(started.state, {
    type: "thread.event",
    event: { type: "workflow.finished", taskId: "task-a", id: "wf-1", status: "completed", summary: "Dynamic workflow completed" },
  });
  assert.equal(finished.state.workflows["task-a"][0].status, "completed");
  assert.deepEqual(deriveView(finished.state).workflows, finished.state.workflows["task-a"]);

  const stranger = reduce(idle, {
    type: "thread.event",
    event: { type: "workflow.started", taskId: "task-gone", id: "wf-2", name: "spec", description: "Write the spec" },
  });
  assert.deepEqual(stranger.state, idle, "a thread that is gone keeps nothing");
});

test("stopping a workflow reaches the thread's session after the run that started it has ended", () => {
  const workflow: Workflow = {
    id: "wf-1",
    name: "review-changes",
    description: "Review changed files",
    status: "running",
    phases: [],
    agents: [{ index: 0, label: "review:bugs", state: "running" }],
    totalTokens: 10,
    totalToolCalls: 1,
    startedAt: 1,
  };
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a", workflows: { "task-a": [workflow] } });

  const stopping = reduce(state, { type: "run.stop-process", processId: "wf-1" });
  assert.deepEqual(stopping.effects, [
    { type: "send-run-command", command: { type: "stop-process", taskId: "task-a", processId: "wf-1" } },
  ]);
  assert.equal(stopping.state.workflows["task-a"][0].stopping, true);
  assert.deepEqual(deriveView(stopping.state).workflows, stopping.state.workflows["task-a"]);

  assert.deepEqual(reduce(stopping.state, { type: "run.stop-process", processId: "wf-1" }).effects, [], "a stop already on its way is not repeated");
  const ended = workspace({ tasks: [task("task-a")], currentId: "task-a", workflows: { "task-a": [{ ...workflow, status: "completed" }] } });
  assert.deepEqual(reduce(ended, { type: "run.stop-process", processId: "wf-1" }).effects, [], "a workflow that already ended has nothing to stop");
});
