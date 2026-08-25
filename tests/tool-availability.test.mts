import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../src/application/workspace-state.ts";
import { viewPreferences } from "../src/application/view-preferences.ts";
import type { InternalStartRunCommand } from "../src/contracts/ipc.ts";
import type { AgentProvider, BrowserBridge, ProviderResult, ProviderRunInput } from "../src/main/agent/agent-provider.mts";
import { ClaudeAgentProvider } from "../src/main/agent/claude-agent-provider.mts";
import { RunCoordinator } from "../src/main/agent/run-coordinator.mts";
import type { WorkspaceRecord } from "../src/domain/workspace.ts";
import { input, queryFactory, type QueryCapture } from "./support/claude-session.mjs";
import { registered, startMainProcess, waitFor } from "./support/electron-harness.mjs";

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" } satisfies WorkspaceRecord;

/** Sends the draft and settles its workspace, which is what puts a start-run command together. */
function started(state: WorkspaceState) {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const pending = sending.effects.find((effect) => effect.type === "resolve-run-workspace");
  assert.ok(pending);
  const start = reduce(sending.state, { type: "run.resolved", pendingId: pending.pendingId, workspace: PROJECTLESS }).effects.find((effect) => effect.type === "start-run");
  assert.ok(start);
  return start.command;
}

function systemAppend(capture: QueryCapture) {
  const prompt = capture.options?.options?.systemPrompt;
  assert.ok(prompt && typeof prompt === "object" && !Array.isArray(prompt));
  return prompt.append ?? "";
}

test("both capabilities start on, are remembered, and mark only the runs they are off for", () => {
  const drafted = reduce(emptyWorkspaceState(), { type: "view.set-prompt", prompt: "look at the app" }).state;
  assert.equal(drafted.computerUse, true);
  assert.equal(drafted.browserTools, true);
  assert.equal(started(drafted).computerUseTools, undefined);
  assert.equal(started(drafted).browserTools, undefined);

  const off = reduce(reduce(drafted, { type: "view.set-computer-use", enabled: false }).state, { type: "view.set-browser-tools", enabled: false });
  assert.equal(off.state.computerUse, false);
  assert.equal(off.state.browserTools, false);
  const persisted = off.effects.find((effect) => effect.type === "persist-preferences");
  assert.ok(persisted);
  assert.equal(persisted.preferences.browserTools, false);
  assert.deepEqual(reduce(off.state, { type: "view.set-browser-tools", enabled: false }).effects, [], "an unchanged choice writes nothing");

  assert.equal(started(off.state).computerUseTools, false);
  assert.equal(started(off.state).browserTools, false);
});

test("a stored choice survives the store loading", () => {
  const preferences = { ...viewPreferences(emptyWorkspaceState()), computerUse: false, browserTools: false };
  const loaded = reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences }).state;
  assert.equal(loaded.computerUse, false);
  assert.equal(loaded.browserTools, false);
});

test("a run with computer use unavailable is told nothing about operating other applications", async () => {
  const capture: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(input({ computerUse: { status: "unavailable", message: "Computer use is turned off in Settings." } }));
  assert.equal(capture.options?.options?.mcpServers, undefined);
  assert.doesNotMatch(systemAppend(capture), /Never invoke a separately installed cua-driver through Bash/);
});

class RecordingProvider implements AgentProvider {
  inputs: ProviderRunInput[] = [];
  async execute(runInput: ProviderRunInput): Promise<ProviderResult> {
    this.inputs.push(runInput);
    return { status: "succeeded" };
  }
  stopProcess() { return false; }
  closeAll() {}
}

const command = (overrides: Partial<InternalStartRunCommand> = {}): InternalStartRunCommand => ({
  type: "start",
  channel: "main",
  taskId: "task-1",
  runId: "run-1",
  prompt: "read the page",
  workspaceId: "workspace-test",
  workspaceRoot: "/tmp/project",
  projectless: false,
  computerUse: { status: "unavailable", message: "test" },
  policy: "confirm",
  model: "opus",
  effort: "high",
  ...overrides,
});

test("a run the browser setting is off for gets no bridge to the panel", async () => {
  const provider = new RecordingProvider();
  const bridge = { command: async () => undefined, read: async () => ({ kind: "tabs" as const, tabs: [] }) } as unknown as BrowserBridge;
  const coordinator = new RunCoordinator(provider, () => {}, { browser: () => bridge });

  coordinator.start(command());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.inputs[0]?.browser, bridge);

  coordinator.start(command({ taskId: "task-2", browserTools: false }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.inputs[1]?.browser, undefined);
});

test("a run the computer-use setting is off for never reaches the driver", async (t) => {
  let driverCalls = 0;
  const main = await startMainProcess(t, "aicodingtool-computer-use-off-", {
    computerUse: {
      computerUseForRun: async () => { driverCalls += 1; return { status: "setup-required" }; },
      computerUsePermissions: async () => ({ accessibility: false, screenRecording: false }),
      requestComputerUsePermission: async () => ({ accessibility: false, screenRecording: false }),
      stopComputerUse: async () => {},
    },
  });
  const projectless = await registered<(event: { sender: unknown }) => Promise<WorkspaceRecord>>(main.handlers, "workspace:projectless")(main.trusted);
  const runCommand = registered<(event: { sender: unknown }, payload: unknown) => void>(main.listeners, "run:command");
  const start = (runId: string, overrides: Partial<InternalStartRunCommand>) => runCommand(main.trusted, {
    type: "start", channel: "main", taskId: runId, runId, prompt: "look around",
    workspaceId: projectless.id, policy: "confirm", model: "opus", effort: "high", ...overrides,
  });

  start("run-off", { computerUseTools: false });
  await waitFor(() => main.agents[0]?.messages.some((message) => message.runId === "run-off"));
  assert.equal(driverCalls, 0);
  assert.deepEqual(main.agents[0].messages.find((message) => message.runId === "run-off")?.computerUse, { status: "unavailable", message: "Computer use is turned off in Settings." });

  start("run-on", {});
  await waitFor(() => main.agents[0].messages.some((message) => message.runId === "run-on"));
  assert.equal(driverCalls, 1);
});
