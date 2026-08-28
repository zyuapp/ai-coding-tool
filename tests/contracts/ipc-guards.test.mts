import assert from "node:assert/strict";
import { test } from "vitest";
import { isAutomationAck, isAutomationRequest, isAutomationResponse, isBackgroundEvent, isExternalCommand, isGoalEvent, isInternalRunCommand, isRunCommand, isRunEvent, isSubagentEvent, isThreadRequest, isThreadResponse, isWorkflowEvent } from "../../src/contracts/ipc.ts";

const command = {
  type: "start",
  channel: "main",
  taskId: "task-1",
  runId: "run-1",
  prompt: "inspect",
  workspaceId: "workspace-1",
  policy: "confirm",
  engine: "claude",
  model: "opus",
  effort: "high",
};

test("external start commands carry only a workspace ID", () => {
  assert.equal(isRunCommand(command), true);
  assert.equal(isRunCommand({ ...command, workspaceRoot: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, projectless: true }), false);
  assert.equal(isRunCommand({ ...command, computerUse: { status: "setup-required" } }), false);
  assert.equal(isRunCommand({ ...command, cwd: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, sessionId: "claude-session" }), false);
  assert.equal(isRunCommand({ ...command, channel: "background" }), false);
  assert.equal(isRunCommand({ ...command, channel: "side", forkContinuation: true }), false);
  assert.equal(isRunCommand({ ...command, channel: "side", continuation: { provider: "claude", value: "session" }, forkContinuation: true }), true);
});

test("start commands carry the Claude engine's settings as one object", () => {
  assert.equal(isRunCommand({ ...command, claude: {} }), true);
  assert.equal(isRunCommand({ ...command, claude: { outputStyle: "Plain", chromeBrowser: true } }), true);
  assert.equal(isRunCommand({ ...command, claude: { chromeBrowser: false } }), false);
  assert.equal(isRunCommand({ ...command, claude: { outputStyle: 3 } }), false);
  assert.equal(isRunCommand({ ...command, claude: "Plain" }), false);
});

test("manual compaction is a validated Sol thread operation", () => {
  const compact = {
    ...command,
    engine: "codex",
    model: "gpt-5.6-sol",
    prompt: "",
    continuation: { provider: "codex", value: "thread-1" },
    operation: { type: "compact", preTokens: 125_000 },
  };
  assert.equal(isRunCommand(compact), true);
  assert.equal(isRunCommand({ ...compact, model: "gpt-5.6-terra" }), false);
  assert.equal(isRunCommand({ ...compact, prompt: "also answer" }), false);
  assert.equal(isRunCommand({ ...compact, continuation: { provider: "claude", value: "session-1" } }), false);
  assert.equal(isRunCommand({ ...compact, operation: { type: "compact", preTokens: -1 } }), false);
  assert.equal(isRunCommand({ ...compact, forkContinuation: true }), false);
});

test("native Codex reviews accept valid targets and inherited continuation forks", () => {
  const review = {
    ...command,
    engine: "codex",
    model: "gpt-5.6-terra",
    prompt: "",
    continuation: { provider: "codex", value: "thread-1" },
    operation: { type: "review", target: { type: "uncommittedChanges" } },
  };
  assert.equal(isRunCommand(review), true);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "baseBranch", branch: "main" } } }), true);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "commit", sha: "abc123", title: null } } }), true);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "custom", instructions: "Check concurrency." } } }), true);
  assert.equal(isRunCommand({ ...review, prompt: "also answer" }), false);
  assert.equal(isRunCommand({ ...review, channel: "side" }), false);
  assert.equal(isRunCommand({ ...review, continuation: { provider: "claude", value: "session-1" } }), false);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "baseBranch", branch: " " } } }), false);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "commit", sha: "", title: null } } }), false);
  assert.equal(isRunCommand({ ...review, operation: { type: "review", target: { type: "custom", instructions: "" } } }), false);
  assert.equal(isRunCommand({ ...review, forkContinuation: true }), true);
  assert.equal(isRunCommand({ ...review, forkContinuation: false }), false);
});

test("internal worker commands require a resolved root and projectless flag", () => {
  assert.equal(isInternalRunCommand({ ...command, workspaceRoot: "/tmp/project", projectless: false, computerUse: { status: "setup-required" } }), true);
  assert.equal(isInternalRunCommand(command), false);
  assert.equal(isInternalRunCommand({ ...command, workspaceRoot: "/tmp/project" }), false);
});

test("run command guard scopes cancellation and approval", () => {
  assert.equal(isRunCommand({ type: "cancel", taskId: "task-1", runId: "run-1" }), true);
  assert.equal(isRunCommand({ type: "cancel" }), false);
  assert.equal(isRunCommand({ type: "approval", taskId: "task-1", runId: "run-1", approvalId: "approval-1", allow: false }), true);
  assert.equal(isRunCommand({ type: "approval", approvalId: "approval-1", allow: false }), false);
});

test("run command guard scopes stopping one of a run's processes", () => {
  const stop = { type: "stop-process", taskId: "task-1", runId: "run-1", processId: "bash-1" };
  assert.equal(isRunCommand(stop), true);
  assert.equal(isInternalRunCommand(stop), true);
  assert.equal(isRunCommand({ ...stop, processId: "" }), false);
  assert.equal(isRunCommand({ type: "stop-process", taskId: "task-1", runId: "run-1" }), false);
});

test("background event guard validates the process set, and takes no run", () => {
  const base = { type: "background.changed", taskId: "task-1" };
  assert.equal(isBackgroundEvent({ ...base, processes: [] }), true);
  assert.equal(isBackgroundEvent({ ...base, processes: [{ id: "bash-1", kind: "shell", description: "npm run dev" }, { id: "watch-1", kind: "monitor", description: "Deploy events" }] }), true);
  assert.equal(isBackgroundEvent({ ...base, processes: [{ id: "bash-1", kind: "subagent", description: "npm run dev" }] }), false);
  assert.equal(isBackgroundEvent({ ...base, processes: [{ id: "", kind: "shell", description: "npm run dev" }] }), false);
  assert.equal(isBackgroundEvent({ ...base, processes: [{ id: "bash-1", kind: "shell", description: "" }] }), false);
  assert.equal(isBackgroundEvent({ ...base, processes: {} }), false);
  assert.equal(isBackgroundEvent({ type: "workflow.finished", taskId: "task-1", id: "wf-1", status: "stopped", summary: "" }), false);
  assert.equal(isRunEvent({ ...base, runId: "run-1", sequence: 1, processes: [] }), false, "a run no longer carries the set");
});

test("goal event guard validates native state and clearing", () => {
  assert.equal(isGoalEvent({ type: "goal.changed", taskId: "task-1", goal: { objective: "Ship it", status: "active", iterations: 2 } }), true);
  assert.equal(isGoalEvent({ type: "goal.changed", taskId: "task-1", goal: null }), true);
  assert.equal(isGoalEvent({ type: "goal.changed", taskId: "task-1", goal: { objective: "", status: "active" } }), false);
  assert.equal(isGoalEvent({ type: "goal.changed", taskId: "task-1", goal: { objective: "Ship it", status: "paused" } }), false);
});

test("run event guard validates optional status messages", () => {
  const event = { type: "run.status", taskId: "task-1", runId: "run-1", sequence: 1, status: "failed" };
  assert.equal(isRunEvent({ ...event, message: "failed" }), true);
  assert.equal(isRunEvent({ ...event, message: 42 }), false);
});

test("run event guard accepts the computer-use setup signal", () => {
  assert.equal(isRunEvent({ type: "computer-use.setup-required", taskId: "task-1", runId: "run-1", sequence: 1 }), true);
});

test("run event guard accepts a lost continuation", () => {
  assert.equal(isRunEvent({ type: "continuation.lost", taskId: "task-1", runId: "run-1", sequence: 1 }), true);
});

test("run event guard accepts tool intents without a write path", () => {
  assert.equal(isRunEvent({
    type: "tool.intent",
    taskId: "task-1",
    runId: "run-1",
    sequence: 1,
    intent: { toolId: "tool-1", name: "Read", input: {}, writePath: undefined },
  }), true);
});

test("subagent event guard validates thread-scoped lifecycle reports", () => {
  const base = { taskId: "task-1", id: "agent-1" };
  const valid = [
    { ...base, type: "subagent.started", description: "Inspect", agentType: "Explore", sessionScoped: true },
    { ...base, type: "subagent.status", status: "working" },
    { ...base, type: "subagent.status", status: "idle", summary: "Ready for more work" },
    { ...base, type: "subagent.progress", description: "Inspect", agentType: "reviewer", lastToolName: "Read", summary: "Done", totalTokens: 42 },
    { ...base, type: "subagent.activity", activityId: "activity-1", kind: "text", text: "Working" },
    { ...base, type: "subagent.activity", activityId: "activity-2", kind: "tool", title: "Read", text: "{}" },
    { ...base, type: "subagent.finished", status: "completed", summary: "Done" },
    { ...base, type: "subagent.finished", status: "failed", summary: "Failed" },
    { ...base, type: "subagent.finished", status: "stopped", summary: "" },
  ];
  for (const event of valid) assert.equal(isSubagentEvent(event), true, `${event.type}:${"status" in event ? event.status : ""}`);
  assert.equal(isRunEvent({ ...valid[0], runId: "run-1", sequence: 1 }), false, "subagent reports do not pass through the run gate");

  const invalid = [
    { ...valid[0], description: "" },
    { ...valid[0], sessionScoped: false },
    { ...valid[1], status: "waiting" },
    { ...valid[3], totalTokens: -1 },
    { ...valid[3], totalTokens: Number.NaN },
    { ...valid[4], activityId: "" },
    { ...valid[4], kind: "image" },
    { ...valid[5], title: 42 },
    { ...valid[6], status: "idle" },
    { ...valid[6], summary: 42 },
  ];
  for (const event of invalid) assert.equal(isSubagentEvent(event), false, JSON.stringify(event));
});

test("workflow events name a thread instead of a run", () => {
  const started = { type: "workflow.started", taskId: "task-1", id: "wf-1", name: "review-changes", description: "Review changed files" };
  assert.equal(isWorkflowEvent(started), true);
  assert.equal(isRunEvent({ ...started, runId: "run-1", sequence: 1 }), false, "a run event guard does not vouch for a workflow");
  assert.equal(isWorkflowEvent({ ...started, taskId: "" }), false);
  assert.equal(isWorkflowEvent({ ...started, type: "run.started" }), false);

  const progress = { type: "workflow.progress", taskId: "task-1", id: "wf-1", phases: [{ index: 0, title: "Review" }], agents: [{ index: 0, label: "review:bugs", state: "running" }], totalTokens: 10, totalToolCalls: 1 };
  assert.equal(isWorkflowEvent(progress), true);
  assert.equal(isWorkflowEvent({ ...progress, agents: [{ index: 0, label: "review:bugs", state: "thinking" }] }), false);
  assert.equal(isWorkflowEvent({ ...progress, totalTokens: -1 }), false);

  const finished = { type: "workflow.finished", taskId: "task-1", id: "wf-1", status: "completed", summary: "Dynamic workflow completed" };
  assert.equal(isWorkflowEvent(finished), true);
  assert.equal(isWorkflowEvent({ ...finished, status: "running" }), false);
});

test("run guards enforce numeric and string boundaries", () => {
  assert.equal(isRunCommand({ ...command, taskId: "x".repeat(256), prompt: "x".repeat(1_000_000) }), true);
  assert.equal(isRunCommand({ ...command, taskId: "x".repeat(257) }), false);
  assert.equal(isRunCommand({ ...command, prompt: "x".repeat(1_000_001) }), false);
  assert.equal(isRunCommand({ ...command, model: "future-model" }), false);
  assert.equal(isRunCommand({ ...command, effort: "insane" }), false);
  assert.equal(isRunCommand({ ...command, effort: "ultra" }), false, "ultra belongs to Codex");
  assert.equal(isRunCommand({ ...command, engine: "codex", model: "gpt-5.6-sol", effort: "ultra" }), true);
  assert.equal(isRunCommand({ ...command, effort: undefined }), false);
  assert.equal(isRunCommand({ ...command, continuation: { provider: "", value: "session" } }), false);

  const usage = { type: "context.usage", taskId: "task-1", runId: "run-1", sequence: 1, tokens: 0, limit: 1, model: "claude" };
  assert.equal(isRunEvent(usage), true);
  assert.equal(isRunEvent({ ...usage, sequence: 0 }), false);
  assert.equal(isRunEvent({ ...usage, sequence: 1.5 }), false);
  assert.equal(isRunEvent({ ...usage, tokens: -1 }), false);
  assert.equal(isRunEvent({ ...usage, limit: 0 }), false);
});

const automationRequest = { type: "automation.request", requestId: "request-1", taskId: "task-1" };

test("automation requests carry a task and a well-formed payload", () => {
  assert.equal(isAutomationRequest({ ...automationRequest, op: "read" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "list" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "delete" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "poll", schedule: "* * * * *" } }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: { paused: true } }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: {} }), true);

  assert.equal(isAutomationRequest({ ...automationRequest, op: "save" }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { schedule: "* * * * *" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "poll", schedule: "* * * * *", policy: "root" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: { paused: "yes" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "explode" }), false);
  assert.equal(isAutomationRequest({ type: "automation.request", requestId: "request-1", op: "read" }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "", schedule: "* * * * *" } }), false);
});

test("automation responses and acknowledgements are correlated and typed", () => {
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: true, result: null }), true);
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: false, message: "no automation" }), true);
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: false }), false);
  assert.equal(isAutomationResponse({ type: "automation.response", ok: true, result: null }), false);
  assert.equal(isAutomationResponse({ type: "run.status", requestId: "request-1", ok: true }), false);

  assert.equal(isAutomationAck({ automationId: "automation-1", runId: "run-1", started: true }), true);
  assert.equal(isAutomationAck({ automationId: "automation-1", runId: "run-1" }), false);
  assert.equal(isAutomationAck({ automationId: "automation-1", started: false }), false);
});

test("the external command surface covers reading and writing threads, and nothing else", () => {
  assert.equal(isExternalCommand({ type: "task.send", text: "Implement item 1" }), true);
  assert.equal(isExternalCommand({ type: "task.send", taskId: "task-1", text: "Carry on", steer: true }), true);
  assert.equal(isExternalCommand({ type: "task.archive", taskId: "task-1" }), true);
  assert.equal(isExternalCommand({ type: "run.cancel", taskId: "task-1" }), true);

  assert.equal(isExternalCommand({ type: "task.send", text: "Start here", worktreeId: "wt1" }), true);
  assert.equal(isExternalCommand({ type: "task.send", text: "Use Claude", model: "sonnet", effort: "max" }), true);
  assert.equal(isExternalCommand({ type: "task.send", text: "Use mystery", model: "unknown" }), false);
  assert.equal(isExternalCommand({ type: "task.send", text: "Use Claude", effort: "impossible" }), false);
  assert.equal(isExternalCommand({ type: "task.send", taskId: "task-1", text: "Carry on", model: "sonnet" }), false, "a tool cannot change an existing thread's model while messaging it");

  assert.equal(isExternalCommand({ type: "task.send", text: "Look", attachments: [{ path: "/etc/passwd", labels: [] }] }), false);
  assert.equal(isExternalCommand({ type: "task.send", text: "Start here", worktreeId: "/worktrees/repo-wt1" }), true, "a path is only ever a string here; the reducer is what resolves it to a checkout the app made");
  assert.equal(isExternalCommand({ type: "task.send", text: "Start here", worktreeId: 7 }), false);
  assert.equal(isExternalCommand({ type: "task.send" }), false);
  assert.equal(isExternalCommand({ type: "task.archive" }), false);
  assert.equal(isExternalCommand({ type: "task.set-policy", taskId: "task-1", policy: "autonomous" }), false, "the agent does not widen what a thread may do");
  assert.equal(isExternalCommand({ type: "task.rename", taskId: "task-1", title: "Release prep" }), false);
  assert.equal(isExternalCommand({ type: "task.select", taskId: "task-1" }), false, "the agent does not move the user around");
  assert.equal(isExternalCommand({ type: "task.clear-archive" }), false);
  assert.equal(isExternalCommand({ type: "project.remove", projectId: "project-1" }), false);
  assert.equal(isExternalCommand({ type: "run.decide", allow: true }), false, "the agent does not approve its own actions");
  assert.equal(isExternalCommand({ type: "view.set-prompt", prompt: "typed" }), false);
});

test("thread requests carry a caller and a well-formed query", () => {
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "list" }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "list", project: "all", archived: true, idleForMs: 3600000, limit: 20 }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "list", attachments: true }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "list", attachments: "yes" }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "read", threadId: "task-2", limit: 5 }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "wait", threadId: "task-2", timeoutMs: 60_000 }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "wait", threadId: "task-2" }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "wait", threadId: "task-2", timeoutMs: 60 * 60_000 }), false, "a wait cannot be held open forever");
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "command", command: { type: "task.archive", taskId: "task-2" } }), true);

  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", op: "list" }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "list", idleForMs: -1 }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "read" }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "command", command: { type: "task.select", taskId: "task-2" } }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "drop" }), false);
  assert.equal(isThreadResponse({ type: "thread.response", requestId: "r1", ok: true, result: [] }), true);
  assert.equal(isThreadResponse({ type: "thread.response", requestId: "r1", ok: false }), false);
});

test("the browser surface a run may drive names the thread, a tab, and nothing else", () => {
  assert.equal(isExternalCommand({ type: "browser.open", taskId: "task-1", url: "https://example.com" }), true);
  assert.equal(isExternalCommand({ type: "browser.open", taskId: "task-1", url: "https://example.com", tabId: "tab-1", newTab: true }), true);
  assert.equal(isExternalCommand({ type: "browser.go", taskId: "task-1", delta: -1 }), true);
  assert.equal(isExternalCommand({ type: "browser.reload", taskId: "task-1" }), true);
  assert.equal(isExternalCommand({ type: "browser.close-tab", taskId: "task-1", tabId: "tab-1" }), true);
  assert.equal(isExternalCommand({ type: "browser.act", taskId: "task-1", action: { kind: "click", ref: "4" } }), true);
  assert.equal(isExternalCommand({ type: "browser.act", taskId: "task-1", action: { kind: "type", ref: "4", text: "hello", submit: true } }), true);

  assert.equal(isExternalCommand({ type: "browser.open", url: "https://example.com" }), false, "a page loads as the thread that asked or not at all");
  assert.equal(isExternalCommand({ type: "browser.go", taskId: "task-1", delta: 2 }), false);
  assert.equal(isExternalCommand({ type: "browser.act", taskId: "task-1", action: { kind: "scroll", ref: "4" } }), false);
  assert.equal(isExternalCommand({ type: "browser.close-tab", taskId: "task-1" }), false);
  assert.equal(isExternalCommand({ type: "browser.decide", taskId: "task-1", allow: true }), false, "the browser's own approval is the user's");
  assert.equal(isExternalCommand({ type: "browser.clear-data", taskId: "task-1" }), false, "a run cannot sign the user out");
  assert.equal(isExternalCommand({ type: "browser.new-tab", taskId: "task-1" }), false);
});

test("a page read is bounded, and anything else on the browser channel is refused", () => {
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "tabs" } }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "snapshot", timeoutMs: 5_000 } }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "snapshot", tabId: "tab-1", textLimit: 500, timeoutMs: 0 } }), true);

  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "snapshot" } }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "snapshot", timeoutMs: 10 * 60 * 1_000 } }), false, "a read cannot hold a tool call open for ever");
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser", read: { op: "screenshot" } }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "browser" }), false);
});

test("the terminal channel carries reads and nothing else", () => {
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal", read: { op: "terminals" } }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal", read: { op: "snapshot" } }), true);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal", read: { op: "snapshot", terminalId: "terminal-1", lines: 200, match: "error" } }), true);

  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal", read: { op: "snapshot", lines: -1 } }), false);
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal", read: { op: "write", data: "rm -rf /" } }), false, "a run reads a terminal and never drives one");
  assert.equal(isThreadRequest({ type: "thread.request", requestId: "r1", taskId: "task-1", op: "terminal" }), false);

  assert.equal(isExternalCommand({ type: "terminal.open", taskId: "task-1" }), false, "the terminal is the user's own");
  assert.equal(isExternalCommand({ type: "terminal.input", taskId: "task-1", terminalId: "terminal-1", data: "ls\r" }), false);
  assert.equal(isExternalCommand({ type: "terminal.close", taskId: "task-1", terminalId: "terminal-1" }), false);
});

test("what a run reports about itself is bounded before it reaches the workspace", () => {
  const request = { type: "thread.request", requestId: "r1", taskId: "task-1" };
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "5xx on checkout" } }), true);
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "5xx", detail: "## Logs", key: "checkout" } }), true);
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "" } }), false);
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "x".repeat(201) } }), false);
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "5xx", detail: "d".repeat(10_001) } }), false);
  assert.equal(isThreadRequest({ ...request, op: "notify", report: { headline: "5xx", key: 7 } }), false);
  assert.equal(isThreadRequest({ ...request, op: "notify" }), false);
  assert.equal(isThreadRequest({ ...request, op: "nothing-to-report", checked: "the alert feed" }), true);
  assert.equal(isThreadRequest({ ...request, op: "nothing-to-report" }), false);
  assert.equal(isExternalCommand({ type: "automation.notify", taskId: "task-1", headline: "5xx" }), false, "a finding is raised by a run reporting on itself, not by a command anyone may send");
});
