import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { answerMobileRequest, MOBILE_REFUSED, nextMobileUpdate, noMobileView, type MobileBridgeHost } from "../../src/renderer/task-workspace/mobile-bridge.ts";
import { emptyMobileServerState, type MobileServerState, type MobileSessionView } from "../../src/domain/mobile.ts";
import type { MobileRequest, MobileView } from "../../src/contracts/mobile.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

const NOW = 1_800_000_000_000;

function message(text: string, at: number, kind: ConversationMessage["kind"] = "user"): ConversationMessage {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: NOW },
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

function session(id: string): MobileSessionView {
  return { id, deviceId: "device-1", deviceName: "Phone", startedAt: NOW, lastSeenAt: NOW, sequence: 4, connection: "live" };
}

function remoteState(overrides: Partial<MobileServerState> = {}): MobileServerState {
  return { ...emptyMobileServerState(), ...overrides };
}

/** A host that drives the same reducer the window does, recording everything that reached it. */
function host(initial: WorkspaceState) {
  let state = initial;
  const inputs: WorkspaceInput[] = [];
  const bridge: MobileBridgeHost = {
    state: () => state,
    dispatch: (input) => {
      inputs.push(input);
      state = reduce(state, input).state;
    },
    execute: (input) => executeWorkspaceInput(input, {
      state: () => state,
      commit: (next) => { inputs.push(input); state = next; },
      perform: async () => {},
    }),
  };
  return { bridge, inputs, current: () => state };
}

function request(op: MobileRequest): MobileRequest {
  return op;
}

test("a phone is answered as soon as the reducer has decided, not when the run ends", async () => {
  const inputs: WorkspaceInput[] = [];
  let state = workspace({ threads: [task("task-1")], currentId: "task-1" });
  let finishRun = () => undefined as void;
  const bridge: MobileBridgeHost = {
    state: () => state,
    dispatch: (input) => {
      inputs.push(input);
      state = reduce(state, input).state;
    },
    execute: (input) => executeWorkspaceInput(input, {
      state: () => state,
      commit: (next) => { inputs.push(input); state = next; },
      perform: () => new Promise<void>((resolve) => { finishRun = resolve; }),
    }),
  };

  const answered = answerMobileRequest(bridge, request({
    type: "mobile.request", requestId: "req-1", sessionId: "session-1", op: "command",
    command: { type: "task.send", text: "ship it" },
  }));
  const response = await Promise.race([answered, Promise.resolve("still waiting" as const)]);
  assert.notEqual(response, "still waiting", "the phone was left holding the line for the whole run");
  assert.equal(typeof response === "object" && response.ok, true);
  assert.deepEqual(inputs, [{ type: "task.send", text: "ship it" }]);
  finishRun();
});

test("the settings screen's commands describe the bridge's work and never do it", () => {
  const commands: WorkspaceInput[] = [
    { type: "remote.set-enabled", enabled: true },
    { type: "remote.create-pairing-code" },
    { type: "remote.revoke-device", deviceId: "device-1" },
    { type: "remote.refresh" },
  ];
  const expected: WorkspaceEffect[] = [
    { type: "remote.set-enabled", enabled: true },
    { type: "remote.create-pairing-code" },
    { type: "remote.revoke-device", deviceId: "device-1" },
    { type: "remote.refresh" },
  ];
  const before = workspace({ actionError: "something went wrong" });
  commands.forEach((command, index) => {
    const transition = reduce(before, command);
    assert.deepEqual(transition.effects, [expected[index]]);
    assert.deepEqual(transition.state.remote, before.remote);
  });
  /** Every command but the read clears whatever the last one said, so a retry starts clean. */
  assert.equal(reduce(before, { type: "remote.set-enabled", enabled: true }).state.actionError, null);
  assert.equal(reduce(before, { type: "remote.refresh" }).state.actionError, "something went wrong");
});

test("what main reports about the bridge is the only thing that writes it", () => {
  const remote = remoteState({ enabled: true, status: "listening", port: 7737, sessions: [session("session-1")] });
  const next = reduce(workspace(), { type: "remote.changed", remote });
  assert.deepEqual(next.effects, []);
  assert.deepEqual(next.state.remote, remote);
  assert.deepEqual(deriveView(next.state).remote, remote);
});

test("a phone's snapshot request is answered from the window's own state", async () => {
  const driver = host(workspace({
    threads: [task("thread-1", { title: "Rework the sidebar", messages: [message("start", NOW)] })],
    currentId: "thread-1",
  }));

  const response = await answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "req-1", sessionId: "session-1", op: "snapshot" }));
  assert.equal(response.ok, true);
  assert.deepEqual(driver.inputs, []);
  const view = (response as { result: MobileView }).result;
  assert.equal(view.thread?.id, "thread-1");
  assert.deepEqual(view.groups.map((group) => group.name), ["Recents"]);
});

test("a phone's command goes through the same reducer and answers with what the phone now sees", async () => {
  const driver = host(workspace({ threads: [task("thread-1"), task("thread-2")], currentId: "thread-1" }));

  const response = await answerMobileRequest(driver.bridge, request({
    type: "mobile.request",
    requestId: "req-2",
    sessionId: "session-1",
    op: "command",
    command: { type: "task.select", taskId: "thread-2" },
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(driver.inputs, [{ type: "task.select", taskId: "thread-2" }]);
  assert.equal(driver.current().currentId, "thread-2");
  assert.equal((response as { result: MobileView }).result.thread?.id, "thread-2");
});

test("a command the phone is not allowed to send never reaches the reducer", async () => {
  const driver = host(workspace({ threads: [task("thread-1")], currentId: "thread-1" }));
  const refused = [
    { type: "terminal.open" },
    { type: "project.remove", projectId: "project-app" },
    { type: "browser.open", url: "https://example.com" },
    { type: "worktree.delete", taskId: "thread-1" },
    { type: "view.close-tab" },
    /** The shape is right and the type is allowed, but a phone carries no files. */
    { type: "task.send", text: "go", attachments: [{ kind: "image", path: "/tmp/a.png" }] },
    { type: "task.rename", taskId: "", title: "renamed" },
  ];

  for (const command of refused) {
    const response = await answerMobileRequest(driver.bridge, {
      type: "mobile.request",
      requestId: "req-3",
      sessionId: "session-1",
      op: "command",
      command: command as never,
    });
    assert.deepEqual(response, { type: "mobile.response", requestId: "req-3", ok: false, message: MOBILE_REFUSED });
  }
  assert.deepEqual(driver.inputs, []);
  assert.equal(driver.current().currentId, "thread-1");
});

test("a command the reducer refuses answers with what the window said about it", async () => {
  const driver = host(workspace({ threads: [task("thread-1")], currentId: "thread-1", projects: [{ id: "project-app", root: "/code/app" }] }));

  const response = await answerMobileRequest(driver.bridge, request({
    type: "mobile.request",
    requestId: "req-4",
    sessionId: "session-1",
    op: "command",
    command: { type: "task.send", text: "go", project: "nowhere" },
  }));
  assert.equal(response.ok, false);
  assert.match((response as { message: string }).message, /nowhere/);
  const repeated = await answerMobileRequest(driver.bridge, request({
    type: "mobile.request", requestId: "req-5", sessionId: "session-1", op: "command",
    command: { type: "task.send", text: "go", project: "nowhere" },
  }));
  assert.equal(repeated.ok, false);
  assert.match((repeated as { message: string }).message, /nowhere/);
});

test("nothing is published while no phone holds a session, and the first change after one does is whole", () => {
  const held = noMobileView();
  const alone = workspace({ threads: [task("thread-1")], currentId: "thread-1" });
  assert.equal(nextMobileUpdate(held, alone, NOW), null);

  const watched = { ...alone, remote: remoteState({ sessions: [session("session-1")] }) };
  const first = nextMobileUpdate(held, watched, NOW);
  assert.equal(first?.kind, "snapshot");
  assert.equal(nextMobileUpdate(held, watched, NOW), null);

  const renamed = { ...watched, threads: [task("thread-1", { title: "Renamed" })] };
  const second = nextMobileUpdate(held, renamed, NOW);
  assert.equal(second?.kind, "patch");
  assert.deepEqual(second?.kind === "patch" ? second.patch.thread : null, { kind: "changed", id: "thread-1", delta: { title: "Renamed" } });

  /** The last phone leaving forgets what was published, so the next one to arrive is sent everything. */
  assert.equal(nextMobileUpdate(held, alone, NOW), null);
  assert.equal(nextMobileUpdate(held, watched, NOW)?.kind, "snapshot");
});
