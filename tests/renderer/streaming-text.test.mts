import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { Task } from "../../src/domain/task.ts";
import { fireResizeObservers, mount, query } from "../support/renderer-dom.mts";

const { ConversationTimeline, groupTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");
const { StreamingText } = await import("../../src/renderer/components/StreamingText.tsx");

type TimelineProps = React.ComponentProps<typeof ConversationTimeline>;
type TimelineMessage = Task["messages"][number];
type TimelineMessageSeed = Omit<TimelineMessage, "id" | "at">;

function transcript(...messages: TimelineMessageSeed[]): TimelineMessage[] {
  return messages.map((message, index) => ({ id: `m${index}`, at: index * 1000, ...message }));
}

function timelineView(
  messages: TimelineMessage[],
  status: TimelineProps["status"],
  streamingTail: TimelineProps["streamingTail"] = undefined,
  runEndedAt?: number,
  find: TimelineProps["find"] = undefined,
  waitingOn: TimelineProps["waitingOn"] = null,
) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const task: Task = {
    id: "t1", title: "T", engine: "claude", executionPolicy: "confirm", messages,
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    ...(runEndedAt === undefined ? {} : { runEndedAt }),
  };
  return React.createElement(ConversationTimeline, {
    currentTask: task, folder: "/p", status, compacting: false, waitingOn, streamingTail, scrollContainerRef: { current: scroller }, find,
  });
}

function streaming(props: React.ComponentProps<typeof StreamingText>) {
  return React.createElement(StreamingText, { streaming: true, ...props });
}

test("streamed text shows everything that has arrived, with its newest words fading in", async () => {
  const tail = "Checking the reducer before anything else.";
  const view = await mount(streaming({ committed: "", tail }));

  assert.equal(view.container.textContent, tail, "text is never held back behind a paced reveal");
  assert.ok(view.container.querySelector(".stream-word"), "the live block's words are split so each can fade in");
  await view.unmount();
});

test("a finished message renders whole, so returning to a thread does not replay it", async () => {
  const settled = React.createElement(StreamingText, { committed: "The reducer owns every write.\n\n" });
  const view = await mount(settled);

  assert.match(view.container.textContent, /The reducer owns every write\./);
  assert.equal(view.container.querySelector(".stream-word"), null, "finished text is parsed rather than animated in");
  await view.unmount();
});

test("a revealed word keeps its node, so only new words animate in", async () => {
  const view = await mount(streaming({ committed: "", tail: "One two" }));
  const before = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);
  const firstNode = view.container.querySelector(".stream-word");

  await view.render(streaming({ committed: "", tail: "One two three" }));
  const after = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);

  assert.deepEqual(before, ["One ", "two"]);
  assert.deepEqual(after, ["One ", "two ", "three"]);
  assert.equal(view.container.querySelector(".stream-word"), firstNode, "an already-revealed word is not re-created");
  await view.unmount();
});

test("half-written markup is held back rather than shown as literal markers", async () => {
  const view = await mount(streaming({ committed: "## Heading\n\n", tail: "Then a **partly" }));

  assert.equal(query(view.container, "h2").textContent, "Heading");
  assert.equal(view.container.textContent, "HeadingThen a", "the unclosed emphasis run waits instead of showing its markers");
  assert.equal(view.container.querySelector("strong"), null);

  await view.render(streaming({ committed: "## Heading\n\nThen a **partly** written line.\n\n", tail: "" }));
  assert.equal(query(view.container, "strong").textContent, "partly");
  await view.unmount();
});

test("a streamed code fence renders as a code block instead of literal backticks", async () => {
  const view = await mount(streaming({ committed: "", tail: "```ts\nconst reducer = 1;\n" }));

  assert.equal(query(view.container, "pre code").textContent.trim(), "const reducer = 1;");
  assert.doesNotMatch(view.container.textContent, /```/, "the opening fence is never shown as text");
  await view.unmount();
});

test("a table waits for its delimiter row instead of showing pipes", async () => {
  const view = await mount(streaming({ committed: "", tail: "| Channel | Reach |\n" }));
  assert.equal(view.container.textContent, "", "a header row alone would render as literal pipes");

  await view.render(streaming({ committed: "", tail: "| Channel | Reach |\n| --- | --- |\n| side | tools |\n" }));
  assert.equal(query(view.container, "table th").textContent, "Channel");
  assert.doesNotMatch(view.container.textContent, /\|/);
  await view.unmount();
});

test("text committing into a block does not rewind or repeat the reveal", async () => {
  const view = await mount(streaming({ committed: "", tail: "A whole paragraph of text." }));
  assert.equal(view.container.textContent, "A whole paragraph of text.");

  await view.render(streaming({ committed: "A whole paragraph of text.\n\n", tail: "" }));
  assert.equal(view.container.textContent.trim(), "A whole paragraph of text.", "the same text stays put as it becomes a block");
  await view.unmount();
});

test("a tail with no committed message yet still gets a live turn to render into", () => {
  const messages = transcript({ kind: "user", text: "Explain this" });

  assert.deepEqual(groupTimeline(messages, { running: true }).map((group) => group.kind), ["message"]);

  const streaming = groupTimeline(messages, { running: true, tailMessageId: "message-1" });
  assert.deepEqual(streaming.map((group) => group.kind), ["message", "turn"]);
  assert.deepEqual(streaming[1], { kind: "turn", id: "message-1", steps: [], final: null, endsAt: null, live: true });

  const answered = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "Because" });
  assert.deepEqual(groupTimeline(answered, { running: true, tailMessageId: "m1" }).map((group) => group.kind), ["message", "turn"], "the turn that owns the tail is not duplicated");
});

test("a live turn streams its newest text and leaves settled turns alone", async () => {
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "First block.\n\n" });
  const view = await mount(timelineView(messages, "running", { messageId: "m1", text: "Second block still" }));

  assert.equal(query(view.container, ".work-note p").textContent, "First block.");
  assert.match(view.container.textContent, /Second block still/);
  await view.unmount();
});

test("a block committing between tails does not replay the text already read", async () => {
  const streamed = transcript({ kind: "user", text: "Explain this" });
  const view = await mount(timelineView(streamed, "running", { messageId: "reply-1", text: "The reducer owns every write." }));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  /** The delta clears the tail before the next one arrives, which is where a remount would rewind. */
  const committed: Task["messages"] = [...streamed, { id: "reply-1", at: 2000, kind: "assistant", text: "The reducer owns every write.\n\n" }];
  await view.render(timelineView(committed, "running", null));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  await view.render(timelineView(committed, "running", { messageId: "reply-1", text: "Then the" }));
  assert.match(view.container.textContent, /The reducer owns every write\./, "the committed block stays put while the next tail streams on");
  await view.unmount();
});

test("re-opening a running thread shows the text it already streamed, not a replay of it", async () => {
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "A whole block already read.\n\n" });
  const tail = { messageId: "m1", text: "and the line still being written" };
  const first = await mount(timelineView(messages, "running", tail));
  await first.unmount();

  /** Leaving the thread and coming back is a fresh mount, which is where the reveal used to restart. */
  const reopened = await mount(timelineView(messages, "running", tail));
  assert.match(reopened.container.textContent, /A whole block already read\./);
  assert.match(reopened.container.textContent, /and the line still being written/);
  await reopened.unmount();
});

test("a tail renders before the task has a message of its own to attach to", async () => {
  const view = await mount(timelineView([], "running", { messageId: "reply-1", text: "Starting on it" }));

  assert.equal(view.container.querySelector(".empty-state"), null, "a live tail is not an empty task");
  assert.match(view.container.textContent, /Starting on it/);
  await view.unmount();
});

/** A scroll container with the metrics jsdom cannot work out for itself, recording where it is sent. */
function scrollHarness({ scrollHeight = 4000, clientHeight = 600 } = {}) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next: number) => { offset = next; } });
  document.body.append(scroller);
  const sentTo: number[] = [];
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: (optionsOrX?: ScrollToOptions | number, y?: number) => {
    const top = typeof optionsOrX === "number" ? y ?? 0 : optionsOrX?.top ?? 0;
    sentTo.push(top);
    offset = top;
  } });
  const scrollContainerRef = { current: scroller };
  type TimelineProps = React.ComponentProps<typeof ConversationTimeline>;
  const render = (messages: Task["messages"], status: TimelineProps["status"], streamingTail: TimelineProps["streamingTail"]) => React.createElement(ConversationTimeline, {
    currentTask: { id: "t1", title: "T", engine: "claude", executionPolicy: "confirm", messages, continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 },
    folder: "/p", status, compacting: false, streamingTail, scrollContainerRef,
  });
  /** Entries are empty because the transcript's observer only cares that something resized. */
  const resize = async () => act(async () => {
    fireResizeObservers();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return { scroller, sentTo, render, resize, bottom: scrollHeight };
}

test("an answer is read from its top while tool calls still follow the newest line", async () => {
  const harness = scrollHarness();
  const working = transcript({ kind: "user", text: "Explain this" }, { kind: "tool", text: "Bash", detail: "one" });
  const view = await mount(harness.render(working, "running", null));
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "a tool call follows the newest line");

  harness.sentTo.length = 0;
  await view.render(harness.render(working, "running", { messageId: "reply-1", text: "Here is what I found." }));
  await harness.resize();
  assert.ok(harness.sentTo.length > 0, "the view moved when the answer started");
  assert.ok(!harness.sentTo.includes(harness.bottom), `the answer snapped to the bottom instead of its top: ${harness.sentTo}`);

  /** More work after an answer is worth following again. */
  harness.sentTo.length = 0;
  const resumed: Task["messages"] = [...working, { id: "reply-1", at: 3000, kind: "assistant", text: "Here is what I found.\n\n" }, { id: "k2", at: 4000, kind: "tool", text: "Read", detail: "two" }];
  await view.render(harness.render(resumed, "running", null));
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "a tool call after an answer follows again");
  await view.unmount();
});

test("a reader who scrolls away keeps the view, and is offered a way back to the end", async () => {
  const harness = scrollHarness();
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "An answer.\n\n" });
  const view = await mount(harness.render(messages, "idle", null));
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "an idle transcript opens at its foot");
  assert.equal(view.container.querySelector(".scroll-to-end"), null, "hidden while the end is in view");

  /** The reader drags the scrollbar well away from the end. */
  await act(async () => {
    harness.scroller.dispatchEvent(new PointerEvent("pointerdown", { clientX: 850, clientY: 100 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 850, clientY: 400 }));
    harness.scroller.scrollTop = 600;
    harness.scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 850, clientY: 400 }));
  });
  const button = query<HTMLButtonElement>(view.container, ".scroll-to-end");

  harness.sentTo.length = 0;
  await harness.resize();
  assert.deepEqual(harness.sentTo, [], "a transcript the reader scrolled is left where they put it");

  await act(async () => { button.click(); });
  assert.equal(harness.sentTo.at(-1), harness.bottom, "the button returns to the end");
  await view.unmount();
});
