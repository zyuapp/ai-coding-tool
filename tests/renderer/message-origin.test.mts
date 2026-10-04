import assert from "node:assert/strict";
import { test } from "vitest";
import { transcript, timelineView } from "../support/timeline.mts";
import { mount, query } from "../support/renderer-dom.mts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { threadTranscript } from "../../src/application/thread-projection.ts";
import { projectMobileView } from "../../src/application/mobile-projection.ts";
import { createRemoteWorkspaceReader } from "../../src/application/remote-workspace.ts";
import { sentPrompts, type ConversationMessage } from "../../src/domain/conversation.ts";
import { legacyOrigin, originFields } from "../../src/domain/message-origin.ts";
import { parseStoredConversationMessages } from "../../src/domain/thread-storage.ts";
import { groupTimeline } from "../../src/renderer/timeline/grouping.ts";
import { task, workspace, effectAt, required } from "../application/workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

function folded(messages: ConversationMessage[]) {
  return groupTimeline(messages, { running: false, coordinator: true }).map((group) => group.kind === "message" ? group.from ?? null : group.kind);
}

test("a message from another thread keeps its sender, so renaming it or rewording labels changes neither folding nor recall", () => {
  const state = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" }), task("other", { title: "Monday" })] });
  const sending = reduce(state, { type: "task.send", taskId: "lead", text: "Can I merge?", from: "other" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const sent = required(started.state.threads.find((thread) => thread.id === "lead")?.messages.at(-1));
  assert.deepEqual(sent.origin, { kind: "thread", threadId: "other", title: "Monday" });
  assert.equal(sent.detail, "From Monday · other", "an older peer still has a label to show");

  const renamed = reduce(started.state, { type: "task.rename", taskId: "other", title: "Tuesday" }).state;
  const lead = required(renamed.threads.find((thread) => thread.id === "lead"));
  assert.deepEqual(folded(lead.messages), ["From Monday"]);

  const reworded: ConversationMessage[] = [
    { ...sent, detail: "Sent by Monday" },
    { id: "u1", kind: "user", text: "\"One\" ended its turn.", origin: { kind: "coordination" }, detail: "News from your threads", at: 1 },
    { id: "a1", kind: "assistant", text: "One is done.", at: 2 },
    { id: "u2", kind: "user", text: "\"Two\" ended its turn.", origin: { kind: "coordination" }, detail: "News from your threads", at: 3 },
    { id: "a2", kind: "assistant", text: "Two is done.", at: 4 },
    { id: "u3", kind: "user", text: "Poll", origin: { kind: "automation", runNumber: 4 }, detail: "Scheduled tick 4", at: 5 },
    { id: "u4", kind: "user", text: "Typed by me", at: 6 },
  ];
  assert.deepEqual(folded(reworded), ["From Monday", "updates", "Thread updates", "turn", null, null]);
  assert.deepEqual(sentPrompts(reworded).map((prompt) => prompt.text), ["Typed by me"]);
});

test("old stored messages read their labels once and still render the same", () => {
  const stored = [
    { id: "s1", kind: "user", text: "News", detail: "Thread updates", at: 1 },
    { id: "s2", kind: "user", text: "Merge?", detail: "From Fix login · t2", at: 2 },
    { id: "s3", kind: "user", text: "Older", detail: "From Monday", at: 3 },
    { id: "s4", kind: "user", text: "Poll", detail: "Automation run #2", at: 4 },
    { id: "s5", kind: "user", text: "Odd", detail: "Something a build once wrote", at: 5 },
    { id: "s6", kind: "user", text: "Mine", at: 6 },
    { id: "s7", kind: "system", text: "Moved", detail: "Detached at abcdef1", at: 7 },
  ];
  const messages = parseStoredConversationMessages(stored);
  assert.deepEqual(messages.map((message) => message.origin ?? null), [
    { kind: "coordination" },
    { kind: "thread", threadId: "t2", title: "Fix login" },
    { kind: "thread", title: "Monday" },
    { kind: "automation", runNumber: 2 },
    { kind: "legacy", label: "Something a build once wrote" },
    null,
    null,
  ]);
  assert.deepEqual(messages.map((message) => message.detail ?? null), stored.map((message) => message.detail ?? null));
  assert.deepEqual(sentPrompts(messages).map((prompt) => prompt.text), ["Mine"]);

  const state = workspace({ threads: [task("lead", { messages })], currentId: "lead" });
  assert.deepEqual(required(threadTranscript(state, "lead")).messages.map((message) => message.origin ?? null), [
    "Thread updates", "From Fix login · t2", "From Monday", "Automation run #2", "Something a build once wrote", null, null,
  ]);
});

test("a message with an unrecognised label keeps it when queued and delivered again", () => {
  const origin = legacyOrigin("Something a build once wrote");
  assert.deepEqual(originFields(origin), { origin, detail: "Something a build once wrote" });
  assert.deepEqual(parseStoredConversationMessages([{ id: "m", kind: "user", text: "Odd", at: 1, ...originFields(origin) }])[0]?.detail, "Something a build once wrote");
});

test("a newer computer reads an older peer's labelled messages by who sent them", () => {
  const read = createRemoteWorkspaceReader();
  const legacy = [
    { id: "r1", kind: "user", text: "Merge?", detail: "From Fix login · t2", at: 1 },
    { id: "r2", kind: "user", text: "Mine", at: 2 },
  ];
  const wire = { threads: [task("peer", { role: "coordinator", messages: legacy as ConversationMessage[] })], projects: [], currentId: "peer" };
  const first = read(wire);
  const messages = required(first.threads[0]).messages;
  assert.deepEqual(messages[0]?.origin, { kind: "thread", threadId: "t2", title: "Fix login" });
  assert.equal(messages[1], legacy[1], "a message with nothing to read keeps its reference");
  assert.deepEqual(folded(messages), ["From Fix login", null]);
  assert.equal(read({ ...wire, currentId: null }).threads, first.threads, "an unchanged thread is not read again");
});

test("the desktop timeline, the phone and the agent transcript name the same sender", async () => {
  const messages = transcript(
    { kind: "user", text: "Can I merge?", origin: { kind: "thread", threadId: "t2", title: "Fix login" }, detail: "Sent by Fix login" },
  );
  const state = workspace({ threads: [task("t1", { messages })], currentId: "t1" });
  const agent = required(threadTranscript(state, "t1")).messages[0]?.origin;
  const phone = projectMobileView(state, Date.now()).thread?.messages[0]?.origin;
  const view = await mount(timelineView(messages, "idle"));
  const desktop = query(view.container, ".message-origin").textContent;
  await view.unmount();
  assert.equal(agent, "From Fix login · t2");
  assert.equal(phone, agent);
  assert.equal(desktop, agent);
});
