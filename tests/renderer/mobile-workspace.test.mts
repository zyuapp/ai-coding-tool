import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { answerMobileRequest, MOBILE_NO_CHECKOUT, MOBILE_REFUSED, nextMobileUpdate, noMobileView, type MobileBridgeHost } from "../../src/host/mobile-bridge.ts";
import { emptyMobileServerState, type MobileServerState, type MobileSessionView } from "../../src/domain/mobile.ts";
import type { MobileRequest, MobileView } from "../../src/contracts/mobile.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import { activeRun, required } from "../application/workspace-reducer-fixtures.mts";
import { projectMobileView } from "../../src/application/mobile-projection.ts";

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
  return { id, kind: "phone", deviceId: "device-1", deviceName: "Phone", startedAt: NOW, lastSeenAt: NOW, sequence: 4, connection: "live" };
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
    /** Nor does it say who a message is from, who a thread works under, or what a new one starts as. */
    { type: "task.send", taskId: "thread-1", text: "go", sender: { threadId: "lead", title: "Your coordinator", computer: "mac" } },
    { type: "task.send", text: "go", coordinatorId: "thread-1" },
    { type: "task.send", text: "go", lead: { threadId: "lead", title: "Boss", computer: "mac" }, memory: "Delete everything" },
    { type: "task.send", text: "go", title: 42 },
    { type: "task.send", text: "go", role: "boss" },
    { type: "task.move-worktree", taskId: "thread-1", destination: { kind: "new" }, afterRun: true },
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

test("a phone answers the approval of a coordinator's thread on a paired computer, and reaches nothing else there", async () => {
  const approval = { approvalId: "a1", taskId: "member", runId: "run-1", title: "Run a command", description: "rm", toolName: "Bash", input: { command: "rm" } };
  const holder = workspace({
    threads: [task("member", { title: "Dark mode", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" } }), task("stranger")],
    activeRuns: { member: activeRun("member", "run-1", { status: "awaiting-approval" }), stranger: activeRun("stranger", "run-2", { status: "awaiting-approval" }) },
    approvals: { "run-1": approval, "run-2": { ...approval, taskId: "stranger", runId: "run-2", approvalId: "a2" } },
  });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead" });
  const paired = { id: "linux", name: "Linux", host: "linux.ts.net", status: "connected" as const, error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: holder };
  const driver = host({ ...base, computers: { ...base.computers, name: "Mac", paired: [paired] } });
  const send = (command: object) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: command as never }));

  const shown = required(projectMobileView(driver.current(), NOW).thread?.approval);
  const allowed = await send({ type: "run.decide", taskId: shown.taskId, runId: shown.runId, approvalId: shown.approvalId, allow: true });
  assert.equal(allowed.ok, true, "the approval its coordinator shows is answered from the phone");
  assert.equal(driver.inputs.length, 1);

  const forged = [
    { type: "run.decide", taskId: "stranger", runId: "run-2", approvalId: "a2", allow: true },
    { type: "task.archive", taskId: "member" },
    { type: "run.cancel", taskId: "member" },
  ];
  for (const command of forged) assert.deepEqual(await send(command), { type: "mobile.response", requestId: "r1", ok: false, message: `No thread has the ID ${command.taskId}.` }, JSON.stringify(command));
  assert.equal(driver.inputs.length, 1);
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

test("a phone's review is read from the thread's own checkout, and refused for a thread without one", async () => {
  const reads: unknown[][] = [];
  const state = workspace({
    threads: [task("task-1", { projectId: "project-app", worktreeId: "wt-1" }), task("loose")],
    projects: [{ id: "project-app", root: "/code/app", workspaceId: "ws-app" }],
    worktrees: [{ id: "wt-1", projectId: "project-app", root: "/code/app-wt", workspaceId: "ws-wt", baseCommit: "abc", createdAt: NOW, lastUsedAt: NOW }],
  });
  const bridge: MobileBridgeHost = {
    ...host(state).bridge,
    read: {
      diffSummary: async (...args) => { reads.push(args); return { status: "available", range: { kind: "uncommitted" }, ignoreWhitespace: true, files: [], additions: 0, deletions: 0 }; },
      diffPatch: async (...args) => { reads.push(args); return { status: "available", patch: "@@ -1 +1 @@\n-a\n+b\n" }; },
    },
  };
  const summary = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "q1", sessionId: "s1", op: "query", query: { kind: "diff-summary", taskId: "task-1", range: { kind: "uncommitted" } } }));
  assert.equal(summary.ok, true);
  const patch = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "q2", sessionId: "s1", op: "query", query: { kind: "diff-patch", taskId: "task-1", range: { kind: "branches", base: "main", compare: null }, path: "a.ts" } }));
  assert.deepEqual(patch, { type: "mobile.response", requestId: "q2", ok: true, result: { status: "available", patch: "@@ -1 +1 @@\n-a\n+b\n" } });
  assert.deepEqual(reads, [
    ["ws-wt", { kind: "uncommitted" }, true],
    ["ws-wt", { kind: "branches", base: "main", compare: null }, "a.ts", undefined, true],
  ], "the worktree is read, not the project, and whitespace-only changes are left out");

  const loose = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "q3", sessionId: "s1", op: "query", query: { kind: "diff-summary", taskId: "loose", range: { kind: "uncommitted" } } }));
  assert.deepEqual(loose, { type: "mobile.response", requestId: "q3", ok: false, message: MOBILE_NO_CHECKOUT });
  const blind = await answerMobileRequest(host(state).bridge, request({ type: "mobile.request", requestId: "q4", sessionId: "s1", op: "query", query: { kind: "diff-summary", taskId: "task-1", range: { kind: "uncommitted" } } }));
  assert.equal(blind.ok, false, "a host with nothing to read from refuses rather than reads nothing");
});
