import { composer } from "../../support/composer.mts";
import { mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";

import React, { act } from "react";

import type { QueuedMessage } from "../../../src/application/workspace-state.ts";
import type { Annotation, PastedText } from "../../../src/domain/conversation.ts";
import type { DesktopAPI } from "../../../src/contracts/ipc.ts";

Object.defineProperty(window, "desktop", { value: {
  commands: async () => ({ status: "error", message: "unavailable" } as const),
  projectlessWorkspace: async () => ({ id: "workspace-1", kind: "projectless", root: "/project" } as const),
} satisfies Pick<DesktopAPI, "commands" | "projectlessWorkspace"> });

const { AnnotationRow } = await import("../../../src/renderer/components/AnnotationRow.tsx");
const { ConversationComposer } = await import("../../../src/renderer/components/ConversationComposer.tsx");

function item<E>(items: ArrayLike<E>, index: number): E {
  const item = items[index];
  assert.ok(item);
  return item;
}

const annotations: Annotation[] = [
  { id: "a", quote: "const flaky = await agent('grep CI logs')", note: "" },
  { id: "b", quote: "the reducer is the only writer of workspace state", note: "fix the read order" },
];

test("a pill wears the note, and falls back to the quote when no note was taken", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pills = [...view.container.querySelectorAll(".annotation-pill")];

  assert.deepEqual(pills.map((pill) => query(pill, ".annotation-pill-number").textContent), ["1", "2"]);
  assert.equal(query(item(pills, 0), ".annotation-pill-quote").textContent, "“const flaky = await agent('grep CI logs')");
  assert.equal(query(item(pills, 0), ".annotation-card-note").textContent, "No note taken.");
  assert.equal(item(pills, 1).querySelector(".annotation-pill-quote"), null);
  assert.equal(query(item(pills, 1), ".annotation-pill-label").textContent, "fix the read order");
  assert.equal(query(item(pills, 1), ".annotation-card-quote").textContent, item(annotations, 1).quote);
  await view.unmount();
});

test("a keyboard reaches the card the pointer raises", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pill = item(view.container.querySelectorAll(".annotation-pill"), 1);
  const card = query<HTMLElement>(pill, ".annotation-card");

  assert.equal(pill.getAttribute("tabindex"), "0");
  assert.equal(pill.getAttribute("aria-label"), "Annotation 2");
  assert.equal(pill.getAttribute("aria-describedby"), card.id);
  assert.equal(card.getAttribute("role"), "tooltip");
  await view.unmount();
});

test("a sent annotation keeps its card and loses its remove button", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  assert.equal(view.container.querySelectorAll(".annotation-pill button").length, 2);

  await view.render(React.createElement(AnnotationRow, { annotations }));
  assert.equal(view.container.querySelector(".annotation-pill button"), null);
  assert.equal(view.container.querySelectorAll(".annotation-card").length, 2);

  await view.render(React.createElement(AnnotationRow, { annotations: [] }));
  assert.equal(view.container.querySelector(".annotation-row"), null);
  await view.unmount();
});

test("a queued message shows the annotations it carries, and they cannot be removed from the queue", async () => {
  const queued: QueuedMessage[] = [{ id: "q1", text: "make the badge smaller", prompt: "make the badge smaller", attachments: [], annotations }];
  const view = await mount(composer({ queuedMessages: queued }));

  const body = query(view.container, ".queued-message .queued-body");
  assert.equal(query(body, ".queued-text").textContent, "make the badge smaller");
  assert.equal(body.querySelectorAll(".annotation-pill").length, 2, "the queued message wears its pills");
  assert.equal(body.querySelector(".annotation-pill button"), null, "a queued annotation cannot be dropped on its own");
  await view.unmount();
});

test("a send that carried only annotations is still offered back", async () => {
  const recalled: Annotation[][] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "", annotations, pastes: [], files: [], attachments: [] }, { text: "then some words", annotations: [], pastes: [], files: [], attachments: [] }],
      onPromptChange: setPrompt,
      onAnnotationRecall: (put) => { recalled.push(put); },
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const up = () => act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });

  await act(async () => { textarea.focus(); });
  await up();
  assert.equal(textarea.value, "then some words");
  await up();
  assert.equal(textarea.value, "", "the annotation-only send is a step of its own");
  assert.deepEqual(recalled[1], annotations, "and it brings its annotations with it");
  await view.unmount();
});

test("a send that carried only pasted text is offered back with the paste", async () => {
  const pastes = [{ id: "p1", text: "a long pasted block" }];
  const recalled: PastedText[][] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "", annotations: [], pastes, files: [], attachments: [] }],
      onPromptChange: setPrompt,
      onPasteRecall: (put) => { recalled.push(put); },
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');

  await act(async () => { textarea.focus(); });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
  assert.deepEqual(recalled, [pastes], "a paste-only send is a step of its own");
  await view.unmount();
});

test("the up arrow puts a sent message's annotations back with its text", async () => {
  const recalled: Annotation[][] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "make the badge smaller", annotations, pastes: [], files: [], attachments: [] }],
      onPromptChange: setPrompt,
      onAnnotationRecall: (put) => { recalled.push(put); },
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');

  await act(async () => { textarea.focus(); });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
  assert.equal(textarea.value, "make the badge smaller");
  assert.deepEqual(recalled, [annotations], "the annotations come back with the text they were sent with");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
  assert.equal(textarea.value, "", "and the empty draft comes back with no annotations");
  assert.deepEqual(recalled[1], []);
  await view.unmount();
});
