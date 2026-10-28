import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { Thread } from "../../src/domain/thread.ts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { MarkdownMessage } = await import("../../src/renderer/components/MarkdownMessage.tsx");
const { ConversationTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");

/** Records what the clipboard was asked to hold, which jsdom has no clipboard of its own for. */
function clipboard() {
  const written: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); } },
  });
  return written;
}

async function copyFrom(root: ParentNode, label: string) {
  const button = query<HTMLButtonElement>(root, `button[aria-label="${label}"]`);
  await act(async () => { button.click(); });
  return button;
}

const ANSWER = [
  "Here is the shape.",
  "",
  "```json",
  '{ "kind": "turn" }',
  "```",
  "",
  "| step | owner |",
  "| --- | --- |",
  "| write | reducer |",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
].join("\n");

test("a code block copies what is inside its fence, so pasted JSON stays valid", async () => {
  const written = clipboard();
  const view = await mount(React.createElement(MarkdownMessage, { children: ANSWER }));

  await copyFrom(view.container, "Copy the code");

  assert.deepEqual(written, ['{ "kind": "turn" }'], "the fence marks and the language are the block's frame, not its content");
  await view.unmount();
});

test("a table copies as the Markdown it was written as", async () => {
  const written = clipboard();
  const view = await mount(React.createElement(MarkdownMessage, { children: ANSWER }));

  await copyFrom(view.container, "Copy the table");

  assert.equal(item(written[0]), "| step | owner |\n| --- | --- |\n| write | reducer |");
  await view.unmount();
});

test("a diagram copies the text that draws it, not the picture", async () => {
  const written = clipboard();
  const view = await mount(React.createElement(MarkdownMessage, { children: ANSWER }));

  await copyFrom(view.container, "Copy the diagram");

  assert.deepEqual(written, ["graph TD; A-->B;"]);
  await view.unmount();
});

test("a copy shows a tick, and the button holds no text a search could count", async () => {
  clipboard();
  const view = await mount(React.createElement(MarkdownMessage, { children: ANSWER }));

  const before = view.container.textContent;
  const button = await copyFrom(view.container, "Copy the code");

  assert.ok(button.classList.contains("copied"), "the copy is confirmed on the button that was pressed");
  assert.equal(button.dataset.tip, "Copied");
  assert.equal(view.container.textContent, before, "no button writes text into the answer");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  assert.equal(document.querySelector('body > [role="status"]')?.textContent, "Copied", "a screen reader hears the copy land");
  await view.unmount();
});

test("a copy the clipboard refuses says so on the button", async () => {
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  const view = await mount(React.createElement(MarkdownMessage, { children: ANSWER }));
  const button = await copyFrom(view.container, "Copy the code");
  assert.ok(button.classList.contains("failed"));
  assert.equal(button.dataset.tip, "Copy failed");
  await view.unmount();
});

test("a block still being streamed offers no copy button, because its text still grows", async () => {
  const streaming = React.createElement(MarkdownMessage, { children: "```json\n{ \"kind\":", animate: true });
  const view = await mount(streaming);

  assert.equal(view.container.querySelector(".copy-affordance"), null);
  await view.unmount();
});

test("a finished answer copies whole, without the tool work that led to it", async () => {
  const written = clipboard();
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const task: Thread = {
    id: "t1", title: "T", engine: "claude", executionPolicy: "confirm", continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    messages: [
      { id: "m0", at: 1000, kind: "tool", text: "Read", detail: "src/domain/thread.ts" },
      { id: "m1", at: 2000, kind: "assistant", text: ANSWER },
    ],
  };
  const view = await mount(React.createElement(ConversationTimeline, {
    currentThread: task, engine: "claude", engineLabel: "Claude", folder: "/p", status: "idle" as const, compacting: false,
    waitingOn: null, scrollContainerRef: { current: scroller },
  }));

  await copyFrom(view.container, "Copy the answer");

  assert.deepEqual(written, [ANSWER], "the answer is copied as written, and the tool call is not part of it");
  const time = query<HTMLTimeElement>(view.container, ".message-time");
  assert.equal(time.dataset.clock, new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(2000));
  assert.equal(time.textContent, "", "the clock is drawn from its attribute, so no search counts it");
  assert.equal(time.dataset.tip, new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(2000));
  assert.ok(time.compareDocumentPosition(query(view.container, ".message-actions .copy-affordance")) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the time stands before the copy button");
  await view.unmount();
  scroller.remove();
});

test("a message the user sent copies as written and keeps its time out of its text", async () => {
  const written = clipboard();
  const { timelineView, transcript } = await import("../support/timeline.mts");
  const view = await mount(timelineView(transcript({ kind: "user", text: "Rename the reducer" }), "idle"));

  await copyFrom(view.container, "Copy the message");

  assert.deepEqual(written, ["Rename the reducer"]);
  const row = query(view.container, '[data-message-id="m0"]');
  assert.equal(row.textContent, "Rename the reducer", "a search of the message never finds its clock");
  assert.ok(query<HTMLTimeElement>(row, ".message-time").dataset.clock);
  assert.equal(row.querySelector(".message-stack .message-actions"), null, "the time and copy sit beside the message, adding no row under it");
  await view.unmount();
});

test("every answer keeps its time and copy button out of the way until hovered", async () => {
  const { timelineView, transcript } = await import("../support/timeline.mts");
  const messages = transcript(
    { kind: "user", text: "first" },
    { kind: "assistant", text: "older answer" },
    { kind: "user", text: "second" },
    { kind: "assistant", text: "newer answer" },
  );
  const settled = await mount(timelineView(messages, "idle"));
  const turns = [...settled.container.querySelectorAll(".message.turn")];
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.className), ["message assistant turn", "message assistant turn"], "the newest answer is drawn like any other");
  await settled.unmount();
});

test("a tool call's output copies as it was printed", async () => {
  const written = clipboard();
  const { timelineView, transcript } = await import("../support/timeline.mts");
  const view = await mount(timelineView(transcript({ kind: "user", text: "go" }, { kind: "tool", text: "Bash", detail: "$ ls\nsrc" }), "running"));

  const step = query<HTMLDetailsElement>(view.container, ".work-row");
  await act(async () => {
    step.open = true;
    step.dispatchEvent(new Event("toggle"));
  });
  await copyFrom(step, "Copy the output");

  assert.deepEqual(written, ["$ ls\nsrc"]);
  await view.unmount();
});
