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
const draft = { ...answer, type: "question.set-answer" as const, text: "Chicago" };

function asked() { return reduce(running(), { type: "run.event", event: request }).state; }

test("question answers preserve the separate message draft and attachments while advancing to the next question", () => {
  const original = running("task-a", "run-a", {
    prompts: { "task-a": "Keep working on the layout" },
    images: { "task-a": [{ id: "image", path: "/tmp/screenshot.png", label: "Screenshot" }] },
    pastes: { "task-a": [{ id: "paste", text: "Some pasted notes" }] },
    files: { "task-a": [{ id: "file", path: "/tmp/notes.txt", name: "notes.txt" }] },
    annotations: { "task-a": [{ id: "annotation", quote: "Some text", note: "Keep this" }] },
  });
  let state = reduce(original, { type: "run.event", event: request }).state;
  assert.equal(deriveView(state).question?.question, "Which region?");
  assert.equal(deriveView(state).runActive, true);
  state = reduce(state, draft).state;
  const sent = reduce(state, answer);
  assert.deepEqual(effectAt(sent, "send-run-command").command, { type: "answer-question", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "region", text: "Chicago" });
  for (const key of ["prompts", "images", "pastes", "files", "annotations", "queuedMessages"] as const) assert.equal(sent.state[key], original[key], key);
  assert.equal(deriveView(sent.state).question?.submitting, true);
  assert.equal(reduce(sent.state, { ...draft, text: "duplicate" }).state, sent.state);
  assert.deepEqual(reduce(sent.state, { ...answer, text: "duplicate" }).effects, []);
  const received = reduce(sent.state, { type: "run.event", event: { type: "question.answered", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "region", text: "Chicago", sequence: 2 } }).state;
  assert.equal(deriveView(received).question?.id, "color");
  assert.equal(deriveView(received).question?.answer ?? "", "");
  assert.equal(received.threads[0].messages.at(-1)?.text, "Chicago");
  assert.equal(deriveView(received).prompt, "Keep working on the layout");
});

test("messages queue and steer independently while a question answer is drafted", () => {
  let state = reduce(asked(), draft).state;
  state = reduce(state, { type: "view.set-prompt", prompt: "Change direction" }).state;
  const queued = reduce(state, { type: "task.send" });
  assert.equal(queued.state.queuedMessages["task-a"][0].text, "Change direction");
  assert.equal(deriveView(queued.state).question?.answer, "Chicago");
  const steered = reduce(queued.state, { type: "task.steer-queued", taskId: "task-a", messageId: queued.state.queuedMessages["task-a"][0].id });
  assert.equal(effectAt(steered, "send-run-command").command.type, "steer");
  assert.equal(deriveView(steered.state).question?.answer, "Chicago");
});

test("question drafts are addressed independently and stale submissions preserve current drafts", () => {
  let state = reduce(asked(), draft).state;
  state = reduce(state, { ...draft, questionId: "color", text: "Blue" }).state;
  state = reduce(state, { type: "view.set-prompt", prompt: "Keep this" }).state;
  for (const address of [{ runId: "old" }, { requestId: "old" }, { questionId: "old" }]) {
    assert.equal(reduce(state, { ...draft, ...address, text: "Stale" }).state, state);
    assert.deepEqual(reduce(state, { ...answer, ...address }).effects, []);
  }
  assert.equal(state.prompts["task-a"], "Keep this");
  assert.deepEqual(state.activeRuns["task-a"].questions?.map((question) => question.answer), ["Chicago", "Blue"]);
  const cleared = reduce(state, { ...draft, text: "" }).state;
  assert.deepEqual(reduce(cleared, answer).effects, []);
  assert.equal(deriveView(cleared).prompt, "Keep this");
  const ended = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "succeeded" } }).state;
  assert.equal(deriveView(ended).question, undefined);
  assert.equal(deriveView(ended).prompt, "Keep this");
});

test("question events and external answers validate their addresses and content", () => {
  assert.equal(isRunEvent(request), true);
  assert.equal(isRunEvent({ ...request, request: { ...request.request, questions: [request.request.questions[0], request.request.questions[0]] } }), false);
  assert.equal(isRunCommand({ ...answer, type: "answer-question", text: "Chicago" }), true);
  assert.equal(isRunCommand({ ...answer, type: "answer-question", text: " " }), false);
  assert.equal(isMobileCommand({ ...answer, text: "Chicago" }), true);
  assert.equal(isMobileCommand({ ...answer, runId: null, text: "Chicago" }), false);
});
