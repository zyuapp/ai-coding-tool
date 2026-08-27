import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { AnnotationAnchor, Task, TaskMessage } from "../../src/domain/task.ts";
import { dom, mount, query } from "../support/renderer-dom.mts";

const { ConversationTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");

/** jsdom lays nothing out, and the popover is placed from the selected range's box. */
Object.defineProperty(dom.window.Range.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 10, y: 20, width: 40, height: 16, top: 20, right: 50, bottom: 36, left: 10, toJSON: () => ({}) }),
});

type Draft = { quote: string; note: string; anchor: AnnotationAnchor };

const ANSWER: TaskMessage = { id: "m1", kind: "assistant", text: "hello world again", at: 1 };

const TASK = {
  id: "task-1",
  title: "Thread",
  engine: "claude",
  executionPolicy: "confirm",
  continuationStatus: "none",
  lastChangeSnapshot: { files: [], capturedAt: 1 },
  messages: [{ id: "m0", kind: "user", text: "ask", at: 0 }, ANSWER],
  updatedAt: 1,
} as unknown as Task;

function harness(onAdd: (draft: Draft) => void) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  return React.createElement(ConversationTimeline, {
    currentTask: TASK,
    folder: "/repo",
    status: "idle" as const,
    compacting: false,
    scrollContainerRef: { current: scroller },
    onAnnotateAdd: onAdd,
  });
}

/** What the browser does to a word on a double click: it puts a range over it. */
function selectWord(word: string) {
  const root = document.querySelector('[data-message-id="m1"]');
  assert.ok(root, "the answer is drawn");
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
  let node: Node | null = null;
  for (let at = walker.nextNode(); at; at = walker.nextNode()) {
    if (at.nodeValue?.includes(word)) { node = at; break; }
  }
  assert.ok(node, `no text node holding ${word}`);
  const text = node.nodeValue ?? "";
  const range = document.createRange();
  range.setStart(node, text.indexOf(word));
  range.setEnd(node, text.indexOf(word) + word.length);
  const selection = dom.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** React tracks a controlled field through the value setter, which a plain assignment goes around. */
const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;

async function type(field: HTMLInputElement, text: string) {
  await act(async () => {
    setValue?.call(field, text);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function pointer(type: "pointerdown" | "pointerup") {
  await act(async () => { document.dispatchEvent(new dom.window.Event(type, { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

/** Press, release, press, release, with the word selected on the second press, as a browser does it. */
async function doubleClick(word: string) {
  dom.window.getSelection()?.removeAllRanges();
  await pointer("pointerdown");
  await pointer("pointerup");
  await pointer("pointerdown");
  selectWord(word);
  await pointer("pointerup");
}

const toolbar = () => document.querySelector(".annotate-popover");
const editor = () => document.querySelector<HTMLInputElement>(".annotate-editor input");

test("double clicking a word offers to annotate the word it selected", async () => {
  const view = await mount(harness(() => {}));

  selectWord("hello");
  await pointer("pointerup");
  assert.ok(toolbar(), "a selection offers the toolbar");

  await doubleClick("again");
  assert.ok(toolbar(), "the double click leaves the toolbar on the new word rather than taking it away");

  await view.unmount();
});

test("clicking back into the transcript keeps a note the user has typed", async () => {
  const added: Draft[] = [];
  const view = await mount(harness((draft) => added.push(draft)));

  selectWord("hello");
  await pointer("pointerup");
  await act(async () => { query<HTMLButtonElement>(document.body, ".annotate-popover button").click(); });
  const input = editor();
  assert.ok(input, "the note editor is open");
  await act(async () => {
    input.value = "check this";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });


  await doubleClick("again");

  assert.deepEqual(added.map((draft) => [draft.quote, draft.note]), [["hello", "check this"]]);
  assert.equal(editor(), null, "the editor is away, and the note it held is not");
  await view.unmount();
});

test("a note left empty is dropped rather than kept as a blank annotation", async () => {
  const added: Draft[] = [];
  const view = await mount(harness((draft) => added.push(draft)));

  selectWord("hello");
  await pointer("pointerup");
  await act(async () => { query<HTMLButtonElement>(document.body, ".annotate-popover button").click(); });
  assert.ok(editor(), "the note editor is open");

  await doubleClick("again");

  assert.deepEqual(added, []);
  assert.equal(editor(), null);
  await view.unmount();
});

/**
 * What a browser does to the last word of a block: the selection runs past the block's end and
 * lands in whatever follows it, which under an answer is the answer's own row of buttons.
 */
function selectLastWordSpilling(word: string) {
  const root = document.querySelector('[data-message-id="m1"]');
  assert.ok(root, "the answer is drawn");
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
  let node: Node | null = null;
  for (let at = walker.nextNode(); at; at = walker.nextNode()) {
    if (at.nodeValue?.includes(word)) node = at;
  }
  assert.ok(node, `no text node holding ${word}`);
  const after = document.querySelector(".answer-actions");
  assert.ok(after, "the answer has a row of its own under the text");
  const range = document.createRange();
  range.setStart(node, (node.nodeValue ?? "").indexOf(word));
  range.setEnd(after, 0);
  const selection = dom.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

test("a double click on the last paragraph still offers to annotate it", async () => {
  const added: Draft[] = [];
  const view = await mount(harness((draft) => added.push(draft)));

  dom.window.getSelection()?.removeAllRanges();
  await pointer("pointerdown");
  await pointer("pointerup");
  await pointer("pointerdown");
  selectLastWordSpilling("again");
  await pointer("pointerup");

  assert.ok(toolbar(), "the selection running past the block does not take the toolbar away");

  await act(async () => { query<HTMLButtonElement>(document.body, ".annotate-popover button").click(); });
  const input = editor();
  assert.ok(input, "the note editor opens on it");
  await type(input, "note");
  await act(async () => {
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.deepEqual(added.map((draft) => draft.quote), ["again"], "the quote stops at the answer's own text");
  await view.unmount();
});
