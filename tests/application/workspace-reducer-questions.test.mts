import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { isRunCommand, isRunEvent } from "../../src/contracts/ipc.ts";
import { isMobileCommand } from "../../src/contracts/mobile.ts";
import { running, effectAt } from "./workspace-reducer-fixtures.mts";

const request = { type: "question.requested" as const, taskId: "task-a", runId: "run-a", sequence: 1, requestId: "request", request: { blocking: false, questions: [
  { id: "region", header: "Region", question: "Which region?", options: [{ label: "Chicago", description: "Central" }] },
  { id: "color", header: "Color", question: "Which color?", options: [] },
] } };
const answer = { type: "question.answer" as const, taskId: "task-a", runId: "run-a", requestId: "request", questionId: "region" };

function asked() { return reduce(running(), { type: "run.event", event: request }).state; }

test("typing an answer sends a question command and the acknowledgement advances to the next question", () => {
  let state = asked();
  assert.equal(deriveView(state).question?.question, "Which region?");
  assert.equal(deriveView(state).runActive, true);
  state = reduce(state, { type: "view.set-prompt", prompt: "Chicago" }).state;
  const sent = reduce(state, answer);
  assert.deepEqual(effectAt(sent, "send-run-command").command, { type: "answer-question", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "region", text: "Chicago" });
  assert.equal(sent.state.prompts["task-a"], undefined);
  assert.deepEqual(sent.state.queuedMessages, {});
  assert.deepEqual(reduce(sent.state, { ...answer, text: "duplicate" }).effects, []);
  const received = reduce(sent.state, { type: "run.event", event: { type: "question.answered", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "region", text: "Chicago", sequence: 2 } }).state;
  assert.equal(deriveView(received).question?.id, "color");
  assert.equal(received.threads[0].messages.at(-1)?.text, "Chicago");
});

test("question replies keep stale drafts and normal messages can still steer", () => {
  let state = asked();
  state = reduce(state, { type: "view.set-prompt", prompt: "Keep this" }).state;
  const stale = reduce(state, { ...answer, runId: "old" });
  assert.deepEqual(stale.effects, []);
  assert.equal(stale.state.prompts["task-a"], "Keep this");
  state = reduce(state, { type: "question.reply-mode", taskId: "task-a", runId: "run-a", replying: false }).state;
  assert.equal(deriveView(state).replyingToQuestion, false);
  const steered = reduce(state, { type: "task.send", steer: true });
  assert.equal(effectAt(steered, "send-run-command").command.type, "steer");
  assert.equal(deriveView(steered.state).question?.id, "region");
  const ended = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "succeeded" } }).state;
  assert.equal(deriveView(ended).question, undefined);
});

test("a question arriving while a message is drafted leaves the composer in message mode", () => {
  const drafted = reduce(running(), { type: "view.set-prompt", prompt: "Change direction" }).state;
  const state = reduce(drafted, { type: "run.event", event: request }).state;
  assert.equal(deriveView(state).replyingToQuestion, false);
  assert.equal(deriveView(state).prompt, "Change direction");
});

test("question events and external answers validate their addresses and content", () => {
  assert.equal(isRunEvent(request), true);
  assert.equal(isRunEvent({ ...request, request: { ...request.request, questions: [request.request.questions[0], request.request.questions[0]] } }), false);
  assert.equal(isRunCommand({ ...answer, type: "answer-question", text: "Chicago" }), true);
  assert.equal(isRunCommand({ ...answer, type: "answer-question", text: " " }), false);
  assert.equal(isMobileCommand({ ...answer, text: "Chicago" }), true);
  assert.equal(isMobileCommand({ ...answer, runId: null, text: "Chicago" }), false);
});
