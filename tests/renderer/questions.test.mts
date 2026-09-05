import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { ConversationComposerProps } from "../../src/renderer/components/ConversationComposer.tsx";
import { mount, query } from "../support/renderer-dom.mts";

const { ConversationComposer } = await import("../../src/renderer/components/ConversationComposer.tsx");

function renderConversationComposer(overrides: Partial<ConversationComposerProps>) {
  return React.createElement(ConversationComposer, {
    prompt: "", folder: "", mode: "confirm", engine: "codex", engineLabel: "Codex", model: "gpt-6-astra", effort: "high", runActive: true,
    queuedMessages: [], onPromptChange() {}, onModeChange() {}, onModelChange() {}, onEffortChange() {}, onSend() {}, onSteerQueued() {}, onDropQueued() {}, onCancel() {},
    ...overrides,
  });
}

test("the composer submits typed question answers with Enter and can return to messages", async () => {
  window.desktop = { commands: async () => ({ status: "available", commands: [] }), projectlessWorkspace: async () => ({ id: "workspace", kind: "projectless", root: "/tmp" }) } as unknown as DesktopAPI;
  const answers: string[] = [];
  const messages: string[] = [];
  let stops = 0;
  function Harness() {
    const [replying, setReplying] = React.useState(true);
    return renderConversationComposer({
      prompt: "/tmp/project", runActive: true,
      question: { id: "q", questionId: "q", runId: "run", requestId: "request", header: "Folder", question: "Which folder?", options: [], blocking: false },
      replyingToQuestion: replying,
      onQuestionReplyMode: setReplying,
      onAnswerQuestion: (question) => { answers.push(question.questionId); },
      onSend: () => { messages.push("sent"); },
      onCancel: () => { stops += 1; },
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  await act(async () => { textarea.focus(); });
  assert.equal(textarea.placeholder, "Type your answer…");
  assert.equal(view.container.querySelector(".command-menu"), null);
  assert.match(query(view.container, ".question-prompt").textContent, /Working while you answer/);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.deepEqual(answers, ["q"]);
  assert.deepEqual(messages, []);
  await act(async () => { query<HTMLButtonElement>(view.container, ".question-prompt button").click(); });
  assert.notEqual(textarea.placeholder, "Type your answer…");
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ctrlKey: true })); });
  assert.deepEqual(messages, ["sent"]);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop task"]').click(); });
  assert.equal(stops, 1);
  await view.unmount();
});

test.each(["main", "side"] as const)("%s question choices fill the draft without sending and allow custom answers", async (surface) => {
  window.desktop = { commands: async () => ({ status: "available", commands: [] }), projectlessWorkspace: async () => ({ id: "workspace", kind: "projectless", root: "/tmp" }) } as unknown as DesktopAPI;
  const answers: string[] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    const [replying, setReplying] = React.useState(true);
    return renderConversationComposer({
      surface, prompt, onPromptChange: setPrompt,
      question: { id: "q", questionId: "q", runId: "run", requestId: "request", header: "Marker", question: "Which marker?", options: [{ label: "ALPHA", description: "First" }, { label: "BETA", description: "Second" }], blocking: false },
      replyingToQuestion: replying, onQuestionReplyMode: setReplying,
      onAnswerQuestion: () => { answers.push(prompt); },
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  const alpha = query<HTMLInputElement>(view.container, 'input[value="ALPHA"]');
  const beta = query<HTMLInputElement>(view.container, 'input[value="BETA"]');
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send answer"]').disabled, true);
  await act(async () => { alpha.click(); });
  assert.equal(textarea.value, "ALPHA");
  assert.equal(alpha.checked, true);
  await act(async () => { beta.click(); });
  assert.equal(textarea.value, "BETA");
  assert.equal(alpha.checked, false);
  assert.equal(beta.checked, true);
  assert.deepEqual(answers, []);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send answer"]').click(); });
  assert.deepEqual(answers, ["BETA"]);
  await act(async () => { textarea.value = "GAMMA custom"; textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(beta.checked, false);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.deepEqual(answers, ["BETA", "GAMMA custom"]);
  await act(async () => { query<HTMLButtonElement>(view.container, ".question-prompt button").click(); });
  assert.equal(alpha.disabled, true);
  assert.equal(textarea.value, "GAMMA custom");
  await view.unmount();
});
