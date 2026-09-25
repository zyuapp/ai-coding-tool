import assert from "node:assert/strict";
import React from "react";
import { test, vi } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";
import { mount, query } from "../support/renderer-dom.mts";

/** A settled answer draws one copy button, so the count is how often that row has rendered. */
const answerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/renderer/components/CopyButton.tsx", async () => {
  const react = await import("react");
  return {
    CopyButton: ({ label }: { text: string; label: string }) => {
      answerRenders.count += 1;
      return react.createElement("button", { type: "button", "aria-label": label });
    },
  };
});

const { ConversationTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");

type Tail = { messageId: string; text: string };

const thread: Thread = {
  id: "t1", title: "T", engine: "claude", executionPolicy: "confirm", continuationStatus: "none",
  lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  messages: [
    { id: "m0", at: 1000, kind: "user", text: "first" },
    { id: "m1", at: 2000, kind: "assistant", text: "settled answer" },
    { id: "m2", at: 3000, kind: "user", text: "second" },
    { id: "m3", at: 4000, kind: "tool", text: "Read", detail: "src/domain/thread.ts" },
  ],
};

test("a settled row holds still while the live turn streams", async () => {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  const view = (streamingTail: Tail) => React.createElement(ConversationTimeline, {
    currentThread: thread, engine: "claude" as const, engineLabel: "Claude", folder: "/p",
    status: "running" as const, compacting: false, waitingOn: null, streamingTail, scrollContainerRef,
  });

  const mounted = await mount(view({ messageId: "m4", text: "part" }));
  const settled = answerRenders.count;
  assert.ok(settled > 0, "the settled answer is on screen");

  await mounted.render(view({ messageId: "m4", text: "part one" }));
  await mounted.render(view({ messageId: "m4", text: "part one two" }));

  assert.equal(answerRenders.count, settled, "only the live row reads the tail, so settled rows never re-render");
  assert.ok(query(mounted.container, ".timeline").textContent?.includes("part one two"), "the tail still reaches the live turn");

  await mounted.unmount();
  scroller.remove();
});
