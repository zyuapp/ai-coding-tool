import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { PendingQuestion } from "../../src/domain/agent-question.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { mount, query } from "../support/renderer-dom.mts";

const { QuestionPrompt } = await import("../../src/renderer/components/QuestionPrompt.tsx");
const { WorkflowProcessRow, BackgroundProcessRow } = await import("../../src/renderer/components/BackgroundProcessList.tsx");

const question: PendingQuestion = { id: "q", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "" }], blocking: true, runId: "r", requestId: "req", questionId: "q" };

test("Send answer shows the key that sends it, only where that key sends", async () => {
  const prompt = (props: Partial<{ submitOnEnter: boolean; question: PendingQuestion }>) => React.createElement(QuestionPrompt, { question, answer: "Blue", onAnswerChange() {}, onSubmit() {}, ...props });
  const view = await mount(prompt({}));
  const send = () => query<HTMLButtonElement>(view.container, 'button[type="submit"]');
  assert.equal(query(send(), "kbd").getAttribute("aria-hidden"), "true");
  await view.render(prompt({ submitOnEnter: false }));
  assert.equal(send().querySelector("kbd"), null);
  await view.render(prompt({ question: { ...question, submitting: true } }));
  assert.equal(send().textContent, "Sending…");
  await view.unmount();
});

test("a workflow row shows it opens a panel, and Stop reads as a stop at rest", async () => {
  const workflow = (status: Workflow["status"]): Workflow => ({ id: "w", name: "Release", description: "", status, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 });
  const opened: string[] = [];
  const stopped: string[] = [];
  const row = (status: Workflow["status"]) => React.createElement(WorkflowProcessRow, { workflow: workflow(status), onOpen: (id: string) => { opened.push(id); }, onStop: (id: string) => { stopped.push(id); } });
  const view = await mount(row("running"));
  const open = query<HTMLButtonElement>(view.container, ".process-open");
  assert.ok(query(open, ".process-open-chevron"));
  await act(async () => { open.click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".process-stop").click(); });
  assert.deepEqual([opened, stopped], [["w"], []], "Stop asks once more");
  await act(async () => { query<HTMLButtonElement>(view.container, ".process-stop-slot > button.armed").click(); });
  assert.deepEqual([opened, stopped], [["w"], ["w"]]);
  await view.render(row("completed"));
  assert.equal(view.container.querySelector(".process-stop"), null);
  assert.ok(query(view.container, ".process-open .process-open-chevron"));
  await view.unmount();

  const shell = await mount(React.createElement(BackgroundProcessRow, { process: { id: "p", kind: "shell", description: "dev server" }, onStop() {} }));
  assert.equal(query(shell.container, ".process-stop").getAttribute("aria-label"), "Stop dev server");
  await shell.unmount();
});
