import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no ResizeObserver, and the card re-measures its clamp through one. */
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
dom.window.HTMLTextAreaElement.prototype.attachEvent = () => {};
dom.window.HTMLTextAreaElement.prototype.detachEvent = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
window.desktop = { commands: async () => ({ status: "unavailable", commands: [] }), projectlessWorkspace: async () => ({ id: "workspace-1" }) };

const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { AnnotationRow } = await vite.ssrLoadModule("/src/renderer/components/AnnotationRow.tsx");
const { TaskComposer } = await vite.ssrLoadModule("/src/renderer/components/TaskComposer.tsx");

test.after(async () => {
  await vite.close();
  dom.window.close();
});

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const annotations = [
  { id: "a", quote: "const flaky = await agent('grep CI logs')", note: "" },
  { id: "b", quote: "the reducer is the only writer of workspace state", note: "fix the read order" },
];

test("a pill wears the note, and falls back to the quote when no note was taken", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pills = [...view.container.querySelectorAll(".annotation-pill")];

  assert.deepEqual(pills.map((pill) => pill.querySelector(".annotation-pill-number").textContent), ["1", "2"]);
  assert.equal(pills[0].querySelector(".annotation-pill-quote").textContent, "“const flaky = await agent('grep CI logs')");
  assert.equal(pills[0].querySelector(".annotation-card-note").textContent, "No note taken.");
  assert.equal(pills[1].querySelector(".annotation-pill-quote"), null);
  assert.equal(pills[1].querySelector(".annotation-pill-label").textContent, "fix the read order");
  assert.equal(pills[1].querySelector(".annotation-card-quote").textContent, annotations[1].quote);
  await view.unmount();
});

test("a keyboard reaches the card the pointer raises", async () => {
  const view = await mount(React.createElement(AnnotationRow, { annotations, onRemove: () => {} }));
  const pill = view.container.querySelectorAll(".annotation-pill")[1];
  const card = pill.querySelector(".annotation-card");

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

function composer(props) {
  return React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    model: "opus",
    effort: "medium",
    runActive: false,
    queuedMessages: [],
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onEffortChange() {},
    onSend() {},
    onSteerQueued() {},
    onDropQueued() {},
    onCancel() {},
    ...props,
  });
}

test("a queued message shows the annotations it carries, and they cannot be removed from the queue", async () => {
  const queued = [{ id: "q1", text: "make the badge smaller", prompt: "make the badge smaller", attachments: [], annotations }];
  const view = await mount(composer({ queuedMessages: queued }));

  const body = view.container.querySelector(".queued-message .queued-body");
  assert.equal(body.querySelector(".queued-text").textContent, "make the badge smaller");
  assert.equal(body.querySelectorAll(".annotation-pill").length, 2, "the queued message wears its pills");
  assert.equal(body.querySelector(".annotation-pill button"), null, "a queued annotation cannot be dropped on its own");
  await view.unmount();
});

test("a send that carried only annotations is still offered back", async () => {
  const recalled = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "", annotations, pastes: [] }, { text: "then some words", annotations: [], pastes: [] }],
      onPromptChange: setPrompt,
      onAnnotationRecall: (put) => recalled.push(put),
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');
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
  const recalled = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "", annotations: [], pastes }],
      onPromptChange: setPrompt,
      onPasteRecall: (put) => recalled.push(put),
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');

  await act(async () => { textarea.focus(); });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
  assert.deepEqual(recalled, [pastes], "a paste-only send is a step of its own");
  await view.unmount();
});

test("the up arrow puts a sent message's annotations back with its text", async () => {
  const recalled = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "make the badge smaller", annotations, pastes: [] }],
      onPromptChange: setPrompt,
      onAnnotationRecall: (put) => recalled.push(put),
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');

  await act(async () => { textarea.focus(); });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
  assert.equal(textarea.value, "make the badge smaller");
  assert.deepEqual(recalled, [annotations], "the annotations come back with the text they were sent with");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
  assert.equal(textarea.value, "", "and the empty draft comes back with no annotations");
  assert.deepEqual(recalled[1], []);
  await view.unmount();
});
