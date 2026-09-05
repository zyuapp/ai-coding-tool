import assert from "node:assert/strict";
import { test } from "vitest";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy } from "../../support/codex-client.mjs";

const threadId = "thread-1";
const turnId = "turn-1";
const at = { threadId, turnId };
const agentMessage = (id: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> => ({ type: "agentMessage", id, text, phase: "commentary", memoryCitation: null, delivery: null, questions: null });
const completed = (item: ThreadItem) => ({ item, threadId, turnId, completedAtMs: 2 });

async function asking(overrides: Parameters<typeof input>[0] = {}) {
  const codex = harness();
  const asked: string[] = [];
  const result = codex.provider.execute(input({ ...overrides, authorize: async (intent) => { asked.push(intent.name); return "deny"; } }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  return { client, asked, end: async () => { completeTurn(client); await result; codex.provider.closeAll(); } };
}

test("async assistant questions deliver typed answers into the active Codex turn", async () => {
  const requests: import("../../../src/domain/agent-question.ts").QuestionRequest[] = [];
  let answer!: (answers: Record<string, string>) => void;
  const session = await asking({ policy: "bypass", askQuestion: (request) => {
    requests.push(request);
    return new Promise((resolve) => { answer = resolve; });
  } });
  session.client.notify("item/completed", completed({ ...agentMessage("question", ""), delivery: "async", questions: [{ title: "Which region?", options: ["Chicago", "London"] }] }));
  assert.deepEqual(requests, [{ blocking: false, questions: [{ id: "0", header: "Question", question: "Which region?", options: [{ label: "Chicago", description: "" }, { label: "London", description: "" }] }] }]);
  assert.equal(session.client.calls("turn/steer").length, 0);
  answer({ "0": "Chicago, please" });
  await sentBy(session.client, "turn/steer");
  assert.deepEqual(session.client.calls("turn/steer"), [{ threadId, expectedTurnId: turnId, input: [{ type: "text", text: "Which region?\nChicago, please", text_elements: [] }] }]);
  assert.deepEqual(session.asked, []);
  await session.end();
});

test("bypass questions still wait for input and server withdrawal cancels them", async () => {
  let signal: AbortSignal | undefined;
  const session = await asking({ policy: "bypass", askQuestion: (_request, aborted) => {
    signal = aborted;
    return new Promise((resolve) => aborted?.addEventListener("abort", () => resolve(null), { once: true }));
  } });
  void session.client.ask("item/tool/requestUserInput", { ...at, itemId: "ask", questions: [{ id: "q", header: "Region", question: "Which region?", isOther: false, isSecret: false, options: null }], isBlocking: false, autoResolutionMs: null });
  assert.equal(signal?.aborted, false);
  session.client.notify("serverRequest/resolved", { threadId, requestId: 0 });
  assert.equal(signal?.aborted, true);
  await session.end();
});


test("an asynchronous answer cannot steer a turn that has already ended", async () => {
  let answer!: (answers: Record<string, string>) => void;
  const session = await asking({ askQuestion: () => new Promise((resolve) => { answer = resolve; }) });
  session.client.notify("item/completed", completed({ ...agentMessage("question", ""), delivery: "async", questions: [{ title: "Which region?", options: null }] }));
  await session.end();
  answer({ "0": "Chicago" });
  await Promise.resolve();
  assert.equal(session.client.calls("turn/steer").length, 0);
});
