import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentEvent, AutomationFire, RunEvent, StartRunCommand } from "../../src/contracts/ipc.ts";
import type { Automation } from "../../src/domain/automation.ts";
import type { AgentMessage, StartAgentProcess } from "../../src/main/agent-process.ts";
import { startRunHost, type RunHost } from "../../src/main/run-host.ts";
import type { AutomationScheduler } from "../../src/main/automation/automation-scheduler.mts";
import type { WorkspaceService } from "../../src/main/workspace/workspace-service.mts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type FakeAgent = {
  posted: AgentMessage[];
  killed: boolean;
  /** What the worker says back, and how it dies. */
  say: (message: unknown) => void;
  exit: (code: number | null) => void;
};

/** Stands in for the utility process: the same port, driven from the test rather than by a fork. */
function agentProcesses() {
  const started: FakeAgent[] = [];
  const start: StartAgentProcess = (listener) => {
    const agent: FakeAgent = { posted: [], killed: false, say: (message) => listener.message(message), exit: (code) => listener.exit(code) };
    started.push(agent);
    return { post: (message) => agent.posted.push(message), kill: () => { agent.killed = true; } };
  };
  return { started, start };
}

function harness() {
  const sent: Array<{ channel: string; event: unknown }> = [];
  const agents = agentProcesses();
  const host: RunHost = {
    publish: (event) => { sent.push({ channel: "run:event", event }); },
    fire: (fire) => { sent.push({ channel: "automation:fire", event: fire }); return true; },
    ask: (request) => { sent.push({ channel: "thread:request", event: request }); return true; },
    running: () => true,
    workspaces: () => ({
      resolve: (id: string) => Promise.resolve(id === "workspace-1"
        ? { status: "available", workspace: { id, root: "/tmp/project", kind: "project" } }
        : { status: "unavailable", workspace: { id, root: "/tmp/gone", kind: "project" }, reason: "missing" }),
    }) as unknown as WorkspaceService,
    scheduler: () => ({}) as unknown as AutomationScheduler,
    computerUseForRun: () => Promise.resolve({ status: "unavailable" as const, message: "test" }),
    agent: agents.start,
  };
  const events = () => sent.flatMap((entry) => entry.channel === "run:event" ? [entry.event as AgentEvent] : []);
  const statuses = (runId: string) => events().flatMap((event) => event.type === "run.status" && "runId" in event && event.runId === runId ? [event.status] : []);
  return { agents, bridge: startRunHost(host), sent, events, statuses };
}

function startCommand(taskId: string, runId: string, overrides: Partial<StartRunCommand> = {}): StartRunCommand {
  return { type: "start", channel: "main", taskId, title: "Work", runId, prompt: "work", workspaceId: "workspace-1", policy: "confirm", engine: "claude", model: "opus", effort: "high", ...overrides };
}

test("a start reaches the agent process once its workspace resolves, carrying what the run needs", async () => {
  const { agents, bridge } = harness();

  bridge.handleRunCommand(startCommand("task-1", "run-1"));
  assert.equal(agents.started.length, 0, "nothing is forked while the workspace is still being resolved");
  await tick();

  const agent = agents.started[0];
  assert.ok(agent);
  assert.deepEqual(agent.posted, [{
    ...startCommand("task-1", "run-1"),
    workspaceRoot: "/tmp/project",
    projectless: false,
    computerUse: { status: "unavailable", message: "test" },
  }]);
});

test("a start dropped before it is dispatched never reaches an agent process", async () => {
  const { agents, bridge, statuses } = harness();

  bridge.handleRunCommand(startCommand("task-1", "run-cancelled"));
  bridge.handleRunCommand({ type: "cancel", taskId: "task-1", runId: "run-cancelled" });
  bridge.handleRunCommand(startCommand("task-2", "run-old"));
  bridge.handleRunCommand(startCommand("task-2", "run-new"));
  bridge.handleRunCommand(startCommand("task-3", "run-missing", { workspaceId: "workspace-gone" }));
  await tick();

  assert.deepEqual(statuses("run-cancelled"), ["cancelled"]);
  assert.deepEqual(statuses("run-old"), ["cancelled"], "a thread's older start is superseded by its newer one");
  assert.deepEqual(statuses("run-missing"), ["failed"]);
  assert.deepEqual(agents.started[0]?.posted.map((message) => "runId" in message && message.runId), ["run-new"]);
});

test("only a run's next word reaches the renderer, and its terminal status is its last", async () => {
  const { agents, bridge, events } = harness();
  bridge.handleRunCommand(startCommand("task-1", "run-1"));
  await tick();
  const agent = agents.started[0];
  assert.ok(agent);

  const say = (event: RunEvent) => agent.say(event);
  say({ type: "run.started", taskId: "task-1", runId: "run-1", sequence: 1 });
  say({ type: "assistant.delta", taskId: "task-1", runId: "run-1", sequence: 3, messageId: "message-1", text: "hello" });
  say({ type: "assistant.delta", taskId: "task-1", runId: "run-1", sequence: 2, messageId: "message-1", text: "stale" });
  say({ type: "run.status", taskId: "task-1", runId: "run-1", sequence: 4, status: "succeeded" });
  say({ type: "assistant.delta", taskId: "task-1", runId: "run-1", sequence: 5, messageId: "message-1", text: "after the end" });
  say({ type: "run.started", taskId: "task-9", runId: "run-9", sequence: 1 });

  assert.deepEqual(events().map((event) => [event.type, "sequence" in event ? event.sequence : null]), [
    ["run.started", 1],
    ["assistant.delta", 3],
    ["run.status", 4],
    ["run.started", 1],
  ], "a run nobody asked for still opens its own books when the agent begins it");
});

test("an agent process exit fails its live runs and takes their work off the panel", async () => {
  const { agents, bridge, events, statuses } = harness();
  bridge.handleRunCommand(startCommand("task-1", "run-1"));
  await tick();
  const agent = agents.started[0];
  assert.ok(agent);

  agent.say({ type: "run.started", taskId: "task-1", runId: "run-1", sequence: 1 });
  agent.say({ type: "background.changed", taskId: "task-1", processes: [{ id: "bash-1", kind: "shell", description: "npm run dev" }] });
  agent.say({ type: "subagent.started", taskId: "task-1", id: "child-live", description: "Inspect", sessionScoped: true });
  agent.say({ type: "subagent.started", taskId: "task-1", id: "child-idle", description: "Review", sessionScoped: true });
  agent.say({ type: "subagent.status", taskId: "task-1", id: "child-idle", status: "idle" });
  agent.exit(9);

  assert.deepEqual(statuses("run-1"), ["failed"]);
  assert.equal(events().flatMap((event) => event.type === "run.status" && "message" in event ? [event.message] : []).at(-1), "Agent process exited with code 9.");
  assert.deepEqual(events().flatMap((event) => event.type === "background.changed" ? [event.processes.length] : []), [1, 0]);
  assert.deepEqual(events().flatMap((event) => event.type === "subagent.finished" ? [event.id] : []), ["child-live"], "only the child whose turn was live is settled by the crash");
});

test("a scheduled tick waits for the run the renderer started, and skips one it never acknowledges", async () => {
  const { agents, bridge, sent } = harness();
  const automation: Automation = { id: "automation-1", taskId: "task-1", prompt: "check", schedule: "* * * * *", paused: false, createdAt: 0, updatedAt: 0, runCount: 3 };

  const skipped = bridge.dispatchAutomation(automation, { quiet: false, unattended: true });
  const firstFire = sent.filter((entry) => entry.channel === "automation:fire").at(-1)?.event as AutomationFire;
  bridge.acknowledgeAutomation(firstFire.runId, false);
  assert.equal(await skipped, "skipped");

  const settled = bridge.dispatchAutomation(automation, { quiet: false, unattended: true });
  const fire = sent.filter((entry) => entry.channel === "automation:fire").at(-1)?.event as AutomationFire;
  assert.equal(fire.runNumber, 4);
  bridge.acknowledgeAutomation(fire.runId, true);
  bridge.handleRunCommand(startCommand("task-1", fire.runId));
  await tick();
  const agent = agents.started[0];
  assert.ok(agent);
  agent.say({ type: "run.started", taskId: "task-1", runId: fire.runId, sequence: 1 });
  agent.say({ type: "run.status", taskId: "task-1", runId: fire.runId, sequence: 2, status: "succeeded" });

  assert.equal(await settled, "succeeded");
});

test("a request no guard can read is refused rather than dropped", async () => {
  const { agents, bridge } = harness();
  bridge.handleRunCommand(startCommand("task-1", "run-1"));
  await tick();
  const agent = agents.started[0];
  assert.ok(agent);

  agent.say({ type: "thread.request", requestId: "malformed", taskId: "task-1", op: "list", limit: -1 });
  agent.say({ type: "nonsense" });

  assert.deepEqual(agent.posted.slice(1), [{
    type: "thread.response",
    requestId: "malformed",
    ok: false,
    message: "AI Coding Tool could not read that request: one of its fields is not what the request allows.",
  }]);
  bridge.killAgent();
  assert.equal(agent.killed, true);
});
