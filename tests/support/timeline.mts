import React from "react";
import { onTestFinished } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";
import "./renderer-dom.mts";

const { ConversationTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");

export type TimelineProps = React.ComponentProps<typeof ConversationTimeline>;

export type TimelineMessage = Thread["messages"][number];

export type TimelineMessageSeed = Omit<TimelineMessage, "id" | "at">;

export function transcript(...messages: TimelineMessageSeed[]): TimelineMessage[] {
  return messages.map((message, index) => ({ id: `m${index}`, at: index * 1000, ...message }));
}

export function timelineView(
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
  onTestFinished(() => scroller.remove());
  const task: Thread = {
    id: "t1", title: "T", engine: "claude", executionPolicy: "confirm", messages,
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    ...(runEndedAt === undefined ? {} : { runEndedAt }),
  };
  return React.createElement(ConversationTimeline, {
    currentThread: task, engine: "claude", engineLabel: "Claude", folder: "/p", status, compacting: false, waitingOn, streamingTail, scrollContainerRef: { current: scroller }, find,
  });
}
