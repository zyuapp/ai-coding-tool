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
