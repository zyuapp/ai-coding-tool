import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import { reduce, type WorkspaceInput, type WorkspaceEffect } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { running } from "../application/workspace-reducer-fixtures.mts";
import { mount, query } from "../support/renderer-dom.mts";

const { ConversationComposer } = await import("../../src/renderer/components/ConversationComposer.tsx");

async function asking(surface: "main" | "side") {
  window.desktop = { commands: async () => ({ status: "available", commands: [] }), projectlessWorkspace: async () => ({ id: "workspace", kind: "projectless", root: "/tmp" }) } as unknown as DesktopAPI;
  const effects: WorkspaceEffect[] = [];
  let latest = reduce(running("task-a", "run-a", { prompts: { "task-a": "Keep this message" } }), {
    type: "run.event", event: { type: "question.requested", taskId: "task-a", runId: "run-a", sequence: 1, requestId: "request", request: { blocking: false, questions: [
      { id: "color", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "First" }, { label: "Green", description: "Second" }] },
      { id: "region", header: "Region", question: "Which region?", options: [] },
    ] } },
  }).state;
  let dispatch!: (input: WorkspaceInput) => void;
  function Harness() {
    const [state, setState] = React.useState(latest);
    latest = state;
    dispatch = (input) => {
      const next = reduce(latest, input);
      effects.push(...next.effects);
      latest = next.state;
      setState(next.state);
    };
    const view = deriveView(state);
    return React.createElement(ConversationComposer, {
      surface, prompt: view.prompt, folder: "", mode: "confirm", engine: "codex", engineLabel: "Codex", model: "gpt-6-astra", effort: "high", runActive: true,
      question: view.question, queuedMessages: view.queuedMessages,
      onPromptChange: (prompt) => dispatch({ type: "view.set-prompt", prompt }),
      onQuestionAnswerChange: (question, text) => dispatch({ type: "question.set-answer", taskId: "task-a", ...question, text }),
      onAnswerQuestion: (question) => dispatch({ type: "question.answer", taskId: "task-a", ...question }),
      onSend: (_attachments, steer) => dispatch({ type: "task.send", steer }),
      onModeChange() {}, onModelChange() {}, onEffortChange() {}, fastMode: false, onFastModeChange() {}, onSteerQueued() {}, onDropQueued() {}, onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  return { view, effects, get: () => latest, dispatch: (input: WorkspaceInput) => dispatch(input) };
}

async function type(field: HTMLTextAreaElement, text: string) {
  await act(async () => { field.focus(); field.value = text; field.dispatchEvent(new Event("input", { bubbles: true })); });
}

test.each(["main", "side"] as const)("%s choices and custom answers leave the message composer independent", async (surface) => {
  const session = await asking(surface);
  const { container } = session.view;
  const message = query<HTMLTextAreaElement>(container, ".composer textarea");
  const answer = query<HTMLTextAreaElement>(container, ".question-answer textarea");
  const send = query<HTMLButtonElement>(container, '.question-answer button');
  assert.equal(message.value, "Keep this message");
  assert.equal(answer.value, "");
  assert.equal(send.disabled, true);
  await act(async () => { query<HTMLInputElement>(container, 'input[value="Green"]').click(); });
  assert.equal(answer.value, "Green");
  assert.equal(message.value, "Keep this message");
  assert.deepEqual(session.effects, []);
  await type(answer, "Purple, please");
  assert.equal(query<HTMLInputElement>(container, 'input[value="Green"]').checked, false);
  assert.equal(message.value, "Keep this message");
  await act(async () => { send.click(); });
  assert.deepEqual(session.effects, [{ type: "send-run-command", command: { type: "answer-question", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "color", text: "Purple, please" } }]);
  assert.equal(message.value, "Keep this message");
  assert.equal(send.disabled, true);
  await act(async () => { session.dispatch({ type: "run.event", event: { type: "question.answered", taskId: "task-a", runId: "run-a", sequence: 2, requestId: "request", questionId: "color", text: "Purple, please" } }); });
  assert.equal(answer.value, "");
  assert.equal(answer.disabled, false);
  assert.equal(message.value, "Keep this message");
  await session.view.unmount();
});

test("Enter sends only its own field, while Shift+Enter and composition keep the answer editable", async () => {
  const session = await asking("main");
  const answer = query<HTMLTextAreaElement>(session.view.container, ".question-answer textarea");
  const message = query<HTMLTextAreaElement>(session.view.container, ".composer textarea");
  await type(answer, "Blue\nand green");
  for (const extra of [{ shiftKey: true }, { isComposing: true }]) {
    await act(async () => { answer.focus(); answer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...extra })); });
  }
  assert.deepEqual(session.effects, []);
  await act(async () => { message.focus(); message.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(session.get().queuedMessages["task-a"][0].text, "Keep this message");
  assert.equal(answer.value, "Blue\nand green");
  await act(async () => { answer.focus(); answer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.deepEqual(session.effects, [{ type: "send-run-command", command: { type: "answer-question", taskId: "task-a", runId: "run-a", requestId: "request", questionId: "color", text: "Blue\nand green" } }]);
  await session.view.unmount();
});
