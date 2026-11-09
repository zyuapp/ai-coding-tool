import assert from "node:assert/strict";
import { rankedThread } from "../../src/domain/thread-storage.ts";
import { test, vi } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { deriveView, emptyWorkspaceState, NEW_THREAD_DRAFT, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { answerMobileRequest, MOBILE_DRAFT_BUSY, MOBILE_EDIT_LATE, MOBILE_EDIT_WAIT_MS, MOBILE_NO_CHECKOUT, MOBILE_QUEUED_NOT_WORDS, MOBILE_REFUSED, nextMobileUpdate, noMobileView, type MobileBridgeHost } from "../../src/host/mobile-bridge.ts";
import { QUEUED_NOT_YOURS, QUEUED_SENT } from "../../src/application/computers.ts";
import { emptyMobileServerState, type MobileServerState, type MobileSessionView } from "../../src/domain/mobile.ts";
import type { MobileRequest, MobileView } from "../../src/contracts/mobile.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { COMPUTER_CAPABILITIES, REMOTE_UNSUPPORTED } from "../../src/contracts/computer-capabilities.ts";
import { activeRun, required } from "../application/workspace-reducer-fixtures.mts";
import { projectMobileView } from "../../src/application/mobile-projection.ts";
import { attachmentSendFor } from "../../src/application/composer-attachments.ts";

const NOW = 1_800_000_000_000;

function message(text: string, at: number, kind: ConversationMessage["kind"] = "user"): ConversationMessage {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id: string, overrides: Partial<Thread> = {}): Thread {
  return rankedThread({
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
  });
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
function host(initial: WorkspaceState, perform: (effect: WorkspaceEffect) => Promise<void> = async () => {}) {
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
      perform,
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

const PHOTO = { id: "photo", source: "data:image/png;base64,AQID", annotations: [] };
const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" } as const;

/** The phone's images written to disk and their run started, as the host's effects would. */
function written(state: WorkspaceState): WorkspaceState {
  const saved = reduce(state, { type: "attachments.saved", ids: [PHOTO.id], attachments: [{ path: "/tmp/photo.png", labels: [] }] });
  const resolving = saved.effects.find((effect) => effect.type === "resolve-run-workspace");
  assert.ok(resolving?.type === "resolve-run-workspace", "the send never asked for a place to run");
  return reduce(saved.state, { type: "run.resolved", pendingId: resolving.pendingId, workspace: PROJECTLESS }).state;
}

for (const [kind, text] of [["with words", "From my phone"], ["photo-only", undefined]] as const) {
  test(`a phone's ${kind} send from the new thread's draft starts the draft's thread and opens it`, async () => {
    const driver = host(workspace({ currentId: null, prompts: { [NEW_THREAD_DRAFT]: "typed on the desktop" }, draftRole: "coordinator" }));
    const response = await answerMobileRequest(driver.bridge, request({
      type: "mobile.request", requestId: "req-1", sessionId: "session-1", op: "command",
      command: { type: "attachments.send", ...(text === undefined ? {} : { text }), attachments: [PHOTO] },
    }));
    assert.equal(response.ok, true);
    assert.deepEqual(driver.inputs, [{ type: "view.set-prompt", prompt: text ?? "" }, { type: "attachments.send", attachments: [PHOTO] }]);

    const started = written(driver.current());
    const thread = required(started.threads[0]);
    assert.equal(started.currentId, thread.id, "the computer stayed on the draft, so the phone did too");
    assert.equal(thread.role, "coordinator", "the draft's choices were left behind");
    assert.equal(thread.messages[0]?.text, text ?? "");
    assert.deepEqual(thread.messages[0]?.attachments, ["/tmp/photo.png"]);
    assert.equal(started.prompts[NEW_THREAD_DRAFT], undefined);
  });
}

test("a phone's second send from the draft is refused while the first is still on its way, which keeps the first one's words", async () => {
  const driver = host(workspace({ currentId: null }));
  const send = (requestId: string, text: string) => answerMobileRequest(driver.bridge, request({
    type: "mobile.request", requestId, sessionId: "session-1", op: "command",
    command: { type: "attachments.send", text, attachments: [PHOTO] },
  }));
  assert.equal((await send("req-1", "First")).ok, true);
  const second = await send("req-2", "Second");
  assert.equal(!second.ok && second.message, MOBILE_DRAFT_BUSY);
  for (const command of [{ type: "view.set-prompt", prompt: "Words only" }, { type: "task.send" }] as const) {
    const wordsOnly = await answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: command.type, sessionId: "session-1", op: "command", command }));
    assert.equal(!wordsOnly.ok && wordsOnly.message, MOBILE_DRAFT_BUSY, `${command.type} reached the draft while its pictures were on their way`);
  }

  const started = written(driver.current());
  assert.equal(required(started.threads[0]).messages[0]?.text, "First");
});

test("a phone's images to a thread carry their words and leave the desktop's draft alone", async () => {
  const driver = host(workspace({ threads: [task("task-1")], currentId: "task-1", prompts: { "task-1": "typed on the desktop" } }));
  const response = await answerMobileRequest(driver.bridge, request({
    type: "mobile.request", requestId: "req-1", sessionId: "session-1", op: "command",
    command: { type: "attachments.send", taskId: "task-1", attachments: [PHOTO] },
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(driver.inputs, [{ type: "attachments.send", taskId: "task-1", text: "", attachments: [PHOTO] }]);
  assert.equal(driver.current().prompts["task-1"], "typed on the desktop");
});

test("a phone's photo-only send names its words, so it never waits on the desktop's draft", async () => {
  const driver = host(workspace({ threads: [task("task-1")], currentId: "task-1" }));
  const response = await answerMobileRequest(driver.bridge, request({
    type: "mobile.request", requestId: "req-1", sessionId: "session-1", op: "command",
    command: { type: "attachments.send", attachments: [{ id: "photo", source: "data:image/png;base64,AQID", annotations: [] }] },
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(driver.inputs, [{ type: "attachments.send", text: "", attachments: [{ id: "photo", source: "data:image/png;base64,AQID", annotations: [] }] }]);
  assert.equal(attachmentSendFor(driver.current().attachmentSends).draftKey, undefined);
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

test("a phone opens a coordinator's thread on a paired computer and acts on it there, and reaches no stranger there", async () => {
  const approval = { approvalId: "a1", taskId: "member", runId: "run-1", title: "Run a command", description: "rm", toolName: "Bash", input: { command: "rm" } };
  const queued = { id: "q1", text: "Then the docs", prompt: "Then the docs", attachments: [], usersOwn: true as const };
  const reply = message("See ![shot](shots/dark.png)", NOW + 1, "assistant");
  const holder = workspace({
    threads: [task("member", { title: "Dark mode", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" }, projectId: "p-far", messages: [message("Make it dark", NOW), reply], historySummary: { messageCount: 40, attachmentCount: 0 } }), task("stranger")],
    projects: [{ id: "p-far", root: "/far/app", workspaceId: "ws-far" }],
    currentId: "member",
    activeRuns: { member: activeRun("member", "run-1", { status: "awaiting-approval" }), stranger: activeRun("stranger", "run-2", { status: "awaiting-approval" }) },
    approvals: { "run-1": approval, "run-2": { ...approval, taskId: "stranger", runId: "run-2", approvalId: "a2" } },
    queuedMessages: { member: [queued] },
  });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead" });
  const paired = { id: "linux", name: "Linux", host: "linux.ts.net", status: "connected" as const, error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: holder };
  let holderSays = "";
  const driver = host({ ...base, computers: { ...base.computers, name: "Mac", paired: [paired] } }, async (effect) => {
    if (effect.type === "computer.forward" && holderSays) throw new Error(holderSays);
  });
  const reads: unknown[][] = [];
  driver.bridge.read = {
    diffSummary: async () => assert.fail("no review is read"),
    diffPatch: async () => assert.fail("no patch is read"),
    directories: async () => [],
    transcribeAudio: async () => "",
    readMessageImage: async (...args) => { reads.push(args); return { data: "iVBORw0KGgo=", contentType: "image/png" }; },
  };
  const send = (command: object) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: command as never }));
  const read = (taskId: string) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "q1", sessionId: "s1", op: "query", query: { kind: "thread", taskId } }));

  assert.deepEqual(projectMobileView(driver.current(), NOW).thread?.members?.[0], { id: "member", title: "Dark mode", status: "awaiting-approval", computer: "Linux", online: true });
  const transcript = await read("member");
  assert.deepEqual(transcript.ok && (transcript.result as { messages: unknown[]; omitted: number }).omitted, 38, "what that computer has yet to load counts as left out");
  const image = await answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "i1", sessionId: "s1", op: "query", query: { kind: "image", taskId: "member", messageId: reply.id, href: "shots/dark.png" } }));
  assert.equal(image.ok, true);
  assert.deepEqual(reads, [["shots/dark.png", "/far/app", reply.id, false, "member"]], "read from that computer's checkout");

  const opened = await send({ type: "task.select", taskId: "member" });
  assert.equal(opened.ok, true);
  const shown = required((opened as { result: MobileView }).result.thread);
  assert.deepEqual([shown.id, shown.computer, shown.reviewable, shown.approval?.approvalId, shown.queued[0]?.editable], ["member", "Linux", false, "a1", true]);
  holderSays = QUEUED_SENT;
  assert.deepEqual(await send({ type: "task.edit-queued", taskId: "member", messageId: "q1" }), { type: "mobile.response", requestId: "r1", ok: false, message: QUEUED_SENT }, "it started there before the drop arrived");
  holderSays = "";
  for (const command of [
    { type: "run.decide", taskId: "member", runId: "run-1", approvalId: "a1", allow: true },
    { type: "task.send", taskId: "member", text: "Also the icons" },
    { type: "task.edit-queued", taskId: "member", messageId: "q1" },
  ]) assert.equal((await send(command)).ok, true, JSON.stringify(command));
  assert.deepEqual(driver.inputs.at(-1), { type: "task.drop-queued", taskId: "member", messageId: "q1", ifWaiting: true }, "the queue is that computer's, and the words go back to the phone alone");
  assert.equal(driver.current().prompts.member, undefined);

  const inputs = driver.inputs.length;
  for (const command of [
    { type: "task.select", taskId: "stranger" },
    { type: "run.decide", taskId: "stranger", runId: "run-2", approvalId: "a2", allow: true },
  ]) assert.deepEqual(await send(command), { type: "mobile.response", requestId: "r1", ok: false, message: `No thread has the ID ${command.taskId}.` }, JSON.stringify(command));
  assert.equal((await read("stranger")).ok, false);
  assert.equal(driver.inputs.length, inputs);
});

test("a phone's edit is never asked of a paired computer too old to say the message had gone", async () => {
  const queued = { id: "q1", text: "Then the docs", prompt: "Then the docs", attachments: [], usersOwn: true as const };
  const holder = workspace({ threads: [task("member", { remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" } })], currentId: "member", activeRuns: { member: activeRun("member", "run-1") }, queuedMessages: { member: [queued] } });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead" });
  const linked = (capabilities: readonly string[] | undefined) => ({ id: "linux", name: "Linux", host: "linux.ts.net", status: "connected" as const, error: null, pairedAt: 1, capabilities, state: holder });
  const edit = (driver: ReturnType<typeof host>) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: { type: "task.edit-queued", taskId: "member", messageId: "q1" } }));

  for (const capabilities of [undefined, COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.drop-queued:ifWaiting")]) {
    const old = host({ ...base, computers: { ...base.computers, name: "Mac", active: "linux", paired: [linked(capabilities)] } });
    assert.equal(projectMobileView(old.current(), NOW).thread?.queued[0]?.editable, undefined, "no Edit is offered");
    assert.deepEqual(await edit(old), { type: "mobile.response", requestId: "r1", ok: false, message: REMOTE_UNSUPPORTED });
    assert.deepEqual(old.inputs, []);
  }
});

test("a phone's edit of a paired computer's queue that is not answered in time says so, and words that leave the queue later wait in this computer's composer", async () => {
  const queued = { id: "q1", text: "Then the docs", prompt: "Then the docs", attachments: [], usersOwn: true as const };
  const holder = workspace({ threads: [task("member", { remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" } })], currentId: "member", activeRuns: { member: activeRun("member", "run-1") }, queuedMessages: { member: [queued] } });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead", prompts: { member: "typed here" } });
  const paired = { id: "linux", name: "Linux", host: "linux.ts.net", status: "connected" as const, error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: holder };
  let answer!: () => void;
  const driver = host({ ...base, computers: { ...base.computers, name: "Mac", paired: [paired] } }, () => new Promise<void>((resolve) => { answer = resolve; }));
  /** Taking the edit in can itself wait, behind a read of the thread's history. */
  const execute = driver.bridge.execute;
  driver.bridge.execute = (input) => {
    const execution = execute(input);
    return { ...execution, accepted: new Promise((resolve) => setTimeout(() => resolve(execution.accepted), 4_000)) };
  };

  vi.useFakeTimers();
  try {
    const edited = answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: { type: "task.edit-queued", taskId: "member", messageId: "q1" } }));
    await vi.advanceTimersByTimeAsync(MOBILE_EDIT_WAIT_MS);
    assert.deepEqual(await edited, { type: "mobile.response", requestId: "r1", ok: false, message: MOBILE_EDIT_LATE }, "never told it worked before the holder says so");
  } finally {
    vi.useRealTimers();
  }
  assert.equal(driver.current().prompts.member, "typed here");
  answer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(driver.current().prompts.member, "Then the docs\n\ntyped here");
});

test("a coordinator's thread on a paired computer whose line is down is shown so, and opening it says why it cannot", async () => {
  const holder = workspace({ threads: [task("member", { remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" } })] });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead" });
  const paired = { id: "linux", name: "Linux", host: "linux.ts.net", status: "offline" as const, error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: holder };
  const driver = host({ ...base, computers: { ...base.computers, name: "Mac", paired: [paired] } });

  assert.equal(projectMobileView(driver.current(), NOW).thread?.members?.[0]?.online, false);
  const opened = await answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: { type: "task.select", taskId: "member" } }));
  assert.equal(opened.ok, false);
  assert.match((opened as { message: string }).message, /Linux/);
  assert.equal(driver.current().computers.active, null);
});

test("a phone's edit takes back only its own words, leaves the computer's composer alone, and fails once the message has gone", async () => {
  const own = (id: string, extra: object = {}) => ({ id, text: id, prompt: id, attachments: [], usersOwn: true as const, ...extra });
  const driver = host(workspace({
    threads: [task("thread-1")],
    currentId: "thread-1",
    activeRuns: { "thread-1": activeRun("thread-1", "run-1") },
    prompts: { "thread-1": "typed on the desktop" },
    queuedMessages: { "thread-1": [own("plain"), own("pictured", { attachments: ["/tmp/a.png"] }), own("steering", { steering: true }), { ...own("relayed"), usersOwn: undefined, origin: { kind: "coordination" } }, own("starting")] },
    pendingRuns: { p1: { id: "p1", runId: "run-2", origin: "composer", taskId: "thread-1", text: "starting", prompt: "starting", attachments: [], queuedIds: ["starting"] } },
  }));
  const edit = (messageId: string) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: { type: "task.edit-queued", taskId: "thread-1", messageId } }));

  assert.deepEqual(projectMobileView(driver.current(), NOW).thread?.queued.map((message) => message.editable ?? false), [true, false, false, false, false]);
  assert.equal((await edit("plain")).ok, true);
  assert.deepEqual(driver.current().queuedMessages["thread-1"]?.map((message) => message.id), ["pictured", "steering", "relayed", "starting"]);
  assert.equal(driver.current().prompts["thread-1"], "typed on the desktop");
  assert.deepEqual(await edit("plain"), { type: "mobile.response", requestId: "r1", ok: false, message: QUEUED_SENT }, "it started running meanwhile");
  assert.deepEqual(await edit("steering"), { type: "mobile.response", requestId: "r1", ok: false, message: QUEUED_SENT });
  assert.deepEqual(await edit("pictured"), { type: "mobile.response", requestId: "r1", ok: false, message: MOBILE_QUEUED_NOT_WORDS });
  assert.deepEqual(await edit("relayed"), { type: "mobile.response", requestId: "r1", ok: false, message: QUEUED_NOT_YOURS });
  assert.deepEqual(await edit("starting"), { type: "mobile.response", requestId: "r1", ok: false, message: QUEUED_SENT }, "a starting run is already taking it");
  assert.equal(driver.current().queuedMessages["thread-1"]?.length, 4);
});

test("a phone answers the decision of a coordinator's thread on a paired computer, and no stranger's there", async () => {
  const decision = { id: "d1", question: "Which?", options: [{ label: "A" }], raisedAt: NOW };
  const holder = workspace({ threads: [task("member", { title: "Dark mode", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" }, decisions: [decision] }), task("stranger", { decisions: [decision] })] });
  const base = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })], currentId: "lead" });
  const paired = { id: "linux", name: "Linux", host: "linux.ts.net", status: "connected" as const, error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state: holder };
  const driver = host({ ...base, computers: { ...base.computers, name: "Mac", paired: [paired] } });
  const send = (command: object) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: command as never }));

  const shown = required(projectMobileView(driver.current(), NOW).thread?.decisions?.[0]);
  assert.deepEqual([shown.taskId, shown.from], ["member", "Dark mode"]);
  assert.equal((await send({ type: "decision.answer", taskId: shown.taskId, decisionId: shown.id, answer: "A" })).ok, true);
  assert.equal(driver.inputs.length, 1);
  assert.deepEqual(await send({ type: "decision.answer", taskId: "stranger", decisionId: "d1", answer: "A" }), { type: "mobile.response", requestId: "r1", ok: false, message: "No thread has the ID stranger." });
  assert.equal(driver.inputs.length, 1);
});

test("a phone answers a decision, starts a suggestion, settles a usage pause, snoozes, restores, and stops all, each as the desktop does", async () => {
  const finding = { id: "f1", headline: "Found a bug", at: NOW };
  const driver = host(workspace({
    threads: [
      task("lead", { role: "coordinator", decisions: [{ id: "d1", question: "Which?", options: [{ label: "A", recommended: true }], raisedAt: NOW }], proposals: [{ id: "p1", title: "Tests", named: true, prompt: "Write tests", brief: { intent: "Tests", doneWhen: "Green", delivers: "commit" }, place: {}, proposedAt: NOW }] }),
      task("paused", { limitPause: { resetsAt: NOW + 3_600_000, window: "session", pausedAt: NOW } }),
      task("noisy", { findings: [finding] }),
      task("gone", { archivedAt: NOW }),
      task("worker", { parentId: "lead" }),
    ],
    currentId: "lead",
    activeRuns: { worker: activeRun("worker", "run-w") },
  }));
  const send = (command: object) => answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "command", command: command as never }));
  const thread = (id: string) => required(driver.current().threads.find((item) => item.id === id));

  assert.equal((await send({ type: "decision.answer", taskId: "lead", decisionId: "d1", answer: "A" })).ok, true);
  assert.equal(thread("lead").decisions?.[0]?.answer, "A");
  const started = await send({ type: "proposal.start", taskId: "lead", proposalId: "p1" });
  assert.equal(started.ok, true);
  const suggestion = projectMobileView(driver.current(), NOW).thread?.suggestions?.find((item) => item.id === "p1");
  assert.equal(suggestion === undefined || suggestion.starting === true, true, "the suggestion is on its way");
  assert.equal((await send({ type: "limit.cancel", taskId: "paused" })).ok, true);
  assert.equal(thread("paused").limitPause, undefined);
  assert.equal((await send({ type: "task.snooze", taskId: "noisy", hours: 4 })).ok, true);
  assert.equal(thread("noisy").snoozedUntil !== undefined, true);
  assert.equal(projectMobileView(driver.current(), NOW).activity.snoozed.some((entry) => entry.id === "noisy"), true);
  assert.equal((await send({ type: "task.unsnooze", taskId: "noisy" })).ok, true);
  assert.equal(thread("noisy").snoozedUntil, undefined);

  const listed = await answerMobileRequest(driver.bridge, request({ type: "mobile.request", requestId: "q1", sessionId: "s1", op: "query", query: { kind: "archived" } }));
  assert.deepEqual(listed.ok && (listed.result as Array<{ id: string }>).map((row) => row.id), ["gone"]);
  assert.equal((await send({ type: "task.restore", taskId: "gone" })).ok, true);
  assert.equal(thread("gone").archivedAt, undefined);
  assert.equal(projectMobileView(driver.current(), NOW).archived, 0);

  assert.equal(projectMobileView(driver.current(), NOW).thread?.stoppable, true);
  assert.equal((await send({ type: "coordination.stop-all", taskId: "lead" })).ok, true);
  assert.equal(driver.current().quietStops.includes("run-w"), true, "the run under it is stopped quietly, as Stop all on the desktop stops it");
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
      directories: async (prefix) => { reads.push([prefix]); return ["/code/app", "/code/api"]; },
      transcribeAudio: async (audio) => { reads.push([audio]); return "run the tests"; },
      readMessageImage: async (...args) => { reads.push(args); return { data: "iVBORw0KGgo=", contentType: "image/png" }; },
    },
  };
  const folders = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "q0", sessionId: "s1", op: "query", query: { kind: "directories", prefix: "/code/" } }));
  assert.deepEqual(folders, { type: "mobile.response", requestId: "q0", ok: true, result: ["/code/app", "/code/api"] });
  const spoken = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "qt", sessionId: "s1", op: "query", query: { kind: "transcribe", audio: "UklGRg==" } }));
  assert.deepEqual(spoken, { type: "mobile.response", requestId: "qt", ok: true, result: { text: "run the tests" } });
  const unreadable = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "qu", sessionId: "s1", op: "query", query: { kind: "transcribe", audio: "not base64!" } }));
  assert.equal(unreadable.ok, false, "a recording that is not base64 is refused before it reaches the speech model");
  const hydrated: string[] = [];
  const read = await answerMobileRequest({ ...bridge, hydrate: async (taskId) => { hydrated.push(taskId); } }, request({ type: "mobile.request", requestId: "q00", sessionId: "s1", op: "query", query: { kind: "thread", taskId: "loose" } }));
  assert.equal(read.ok && (read.result as { title: string }).title, "loose");
  assert.deepEqual(hydrated, ["loose"], "a thread not on screen has its stored transcript loaded before it is read");
  const missing = await answerMobileRequest(bridge, request({ type: "mobile.request", requestId: "q01", sessionId: "s1", op: "query", query: { kind: "thread", taskId: "elsewhere" } }));
  assert.deepEqual(missing, { type: "mobile.response", requestId: "q01", ok: false, message: "No thread has the ID elsewhere." });
  reads.length = 0;
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

test("a phone reads only the images a reply links, by the reply's ID, from the thread's checkout", async () => {
  const reply = message("Here: ![Home](shots/home.png) and [settings](/tmp/settings.png).", NOW, "assistant");
  const plain = message("No pictures here.", NOW + 1, "assistant");
  const state = workspace({
    threads: [task("task-1", { projectId: "project-app", worktreeId: "wt-1", messages: [message("show me", NOW - 1), reply, plain] })],
    projects: [{ id: "project-app", root: "/code/app", workspaceId: "ws-app" }],
    worktrees: [{ id: "wt-1", projectId: "project-app", root: "/code/app-wt", workspaceId: "ws-wt", baseCommit: "abc", createdAt: NOW, lastUsedAt: NOW }],
    currentId: "task-1",
  });
  const shown = required(projectMobileView(state, NOW).thread).messages;
  assert.deepEqual(shown.map((item) => item.id), [undefined, reply.id, undefined], "only a reply that may link images carries its ID");

  const reads: unknown[][] = [];
  const bridge: MobileBridgeHost = { ...host(state).bridge, read: {
    diffSummary: async () => assert.fail("no review is read"),
    diffPatch: async () => assert.fail("no patch is read"),
    directories: async () => [],
    transcribeAudio: async () => "",
    readMessageImage: async (...args) => { reads.push(args); return { data: "iVBORw0KGgo=", contentType: "image/png" }; },
  } };
  const ask = (requestId: string, href: string, messageId = reply.id, preview?: boolean) =>
    answerMobileRequest(bridge, request({ type: "mobile.request", requestId, sessionId: "s1", op: "query", query: { kind: "image", taskId: "task-1", messageId, href, ...(preview === undefined ? {} : { preview }) } }));
  assert.deepEqual(await ask("i1", "shots/home.png", reply.id, true), { type: "mobile.response", requestId: "i1", ok: true, result: { data: "iVBORw0KGgo=", contentType: "image/png" } });
  assert.equal((await ask("i2", "/tmp/settings.png")).ok, true);
  assert.deepEqual(reads, [
    ["shots/home.png", "/code/app-wt", reply.id, true, "task-1"],
    ["/tmp/settings.png", "/code/app-wt", reply.id, false, "task-1"],
  ], "a relative link resolves against the checkout the thread works in");
  assert.equal((await ask("i3", "/etc/secret.png")).ok, false, "an image the reply does not link is refused");
  assert.equal((await ask("i4", "shots/home.png", plain.id)).ok, false, "another reply's ID does not reach this one's images");
  assert.equal(reads.length, 2);
});
