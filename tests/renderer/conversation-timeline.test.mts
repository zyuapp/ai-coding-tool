import { type TimelineProps, type TimelineMessage, type TimelineMessageSeed, transcript, timelineView } from "../support/timeline.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi, onTestFinished } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";

import { fireResizeObservers, item, mount, query, rowHeights } from "../support/renderer-dom.mts";

const { ConversationTimeline, groupTimeline, READING_SETTLE_MS } = await import("../../src/renderer/components/ConversationTimeline.tsx");

type TimelineReadingPoint = Parameters<NonNullable<TimelineProps["onReadingPointMove"]>>[0];
type ThreadMountedView = Awaited<ReturnType<typeof mount>>;

async function expand(details: HTMLDetailsElement) {
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

const BOTTOM = 4000;

function threadHarness() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 900 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: BOTTOM });
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next: number) => { offset = next; } });
  const scrolls: number[] = [];
  function recordScroll(options?: ScrollToOptions): void;
  function recordScroll(x: number, y: number): void;
  function recordScroll(options: ScrollToOptions | number = {}, y = 0) {
    const asked = typeof options === "number" ? y : (options.top ?? 0);
    scrolls.push(asked);
    /** A browser can only scroll as far as there is content, and it tells the page once it has moved. */
    const top = Math.max(0, Math.min(asked, scroller.scrollHeight - scroller.clientHeight));
    if (top === offset) return;
    offset = top;
    scroller.dispatchEvent(new Event("scroll"));
  }
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: recordScroll });
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  /** What the workspace would hold, fed back in as each thread is opened. */
  const points: Record<string, TimelineReadingPoint> = {};
  const moves: Array<{ id: string; point: TimelineReadingPoint }> = [];
  const thread = (id: string, count: number, prefix?: string) => {
    const currentThread: Thread = {
      id, title: id, engine: "claude", executionPolicy: "confirm", continuationStatus: "none", updatedAt: 1,
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      messages: transcript(...Array.from({ length: count }, (_, index): TimelineMessageSeed => ({
        kind: index % 2 === 0 ? "user" : "assistant",
        text: `${id} ${index}`,
      })))
        .map((message, index) => (prefix ? { ...message, id: `${prefix}${index}` } : message)),
    };
    return React.createElement(ConversationTimeline, {
      currentThread,
      engine: "claude",
      engineLabel: "Claude",
      folder: "/p", status: "idle", compacting: false, waitingOn: null, scrollContainerRef,
      readingPoint: points[id] ?? null,
      onReadingPointMove: (point: TimelineReadingPoint) => { points[id] = point; moves.push({ id, point }); },
    });
  };
  /** The reader moving the view themselves, which is a scroll with one of their gestures behind it. */
  const scrollTo = async (top: number) => {
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** The virtualizer correcting this scroller once a row measures taller than its estimate. */
  const correctTo = async (top: number) => {
    await act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** The transcript places itself in a frame, which the shimmed one runs on a timer. */
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
  const resize = async () => act(async () => {
    fireResizeObservers();
    await vi.advanceTimersByTimeAsync(40);
  });
  return {
    scroller,
    scrolls,
    points,
    moves,
    thread,
    scrollTo,
    correctTo,
    settle,
    resize,
    done: async (view: ThreadMountedView) => { await view.unmount(); scroller.remove(); },
  };
}

test("a thread reopens where its reader left it, and one left at the foot reopens there", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);

  scrolls.length = 0;
  await view.render(thread("read", 12));
  await settle();
  assert.ok(scrolls.length > 0, "returning to a thread places its view");
  assert.ok(!scrolls.includes(BOTTOM), "a thread left mid-transcript does not reopen at its foot");

  scrolls.length = 0;
  await view.render(thread("foot", 12));
  await settle();
  assert.equal(scrolls.at(-1), BOTTOM, "a thread left at its foot reopens there");

  await done(view);
});

test("a thread that gained messages while its reader was away reopens where they were", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);

  scrolls.length = 0;
  await view.render(thread("read", 14));
  await settle();
  /** New work is appended below, so the reading place above it stands: the view is not sent to its foot. */
  assert.ok(scrolls.length > 0, "the thread still places its view");
  assert.ok(!scrolls.includes(BOTTOM), "an append does not send a returning reader to its foot");

  await done(view);
});

test("a thread whose saved place no longer exists opens at its foot", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();

  /** The history above the place was rewritten out from under it, as a compaction does. */
  scrolls.length = 0;
  await view.render(thread("read", 12, "n"));
  await settle();
  assert.ok(scrolls.length > 0, "the thread still places its view");
  assert.equal(scrolls.at(-1), BOTTOM, "a place whose row is gone opens at the foot");

  await done(view);
});

test("the workspace hears where a reader settles without a switch having to carry it", async () => {
  const { moves, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });

  assert.ok(moves.length >= 1, "the settled place was reported");
  const reported = item(moves.filter((move) => move.id === "read").at(-1));
  assert.ok(reported.point !== null, "a mid-transcript reader is not reported at the foot");
  assert.ok(typeof reported.point.depth === "number", "the report carries how far into the row the view sat");

  /** Reporting the same place again adds nothing for the workspace to hear. */
  const heard = moves.length;
  await scrollTo(300);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  assert.equal(moves.length, heard, "an unchanged place is never reported twice");

  await done(view);
});

test("a reader who scrolls after a restore is left where they put themselves", async () => {
  const { scrolls, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await view.render(thread("read", 12));
  await settle();

  await scrollTo(900);
  scrolls.length = 0;
  await resize();
  assert.deepEqual(scrolls, [], "the restored row stops holding once the reader moves");

  await done(view);
});

test("the virtualizer correcting its own estimates does not take the view from the thread being restored", async () => {
  const { scrolls, points, thread, scrollTo, correctTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  const left = item(points["read"]);

  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();

  /** A row measuring taller than its estimate moves this scroller without the reader touching it. */
  scrolls.length = 0;
  await correctTo(1800);
  await resize();
  assert.ok(scrolls.length >= 1, "the restore keeps placing the row it was asked to hold");

  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  assert.deepEqual(points["read"], left, "the correction is never saved as where the reader was");

  await done(view);
});

test("a row measuring past its estimate corrects the scroller without taking the view", async () => {
  /** Rows far taller than the 64/88/140px estimates, which is what makes the virtualizer correct itself. */
  const measuredRows = rowHeights((node) => node.classList?.contains("timeline-row") ? 620 : 0);
  const { scrolls, points, thread, scrollTo, settle, resize, done } = threadHarness();
  try {
    const view = await mount(thread("read", 12));
    await settle();
    await scrollTo(1200);
    await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
    const left = item(points["read"]);

    await view.render(thread("other", 12, "o"));
    await settle();
    scrolls.length = 0;
    await view.render(thread("read", 12));
    await settle();
    await resize();
    assert.ok(scrolls.length >= 1, "reopening the thread places it rather than leaving it where the other one sat");

    await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
    assert.deepEqual(points["read"], left, "measuring the rows never rewrites where the reader was");

    await done(view);
  } finally {
    measuredRows.restore();
  }
});

test("find opens the fold the match it is showing was written into", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: "retry the build" },
    { kind: "assistant", text: "Done." },
  );
  const find: NonNullable<TimelineProps["find"]> = {
    target: { kind: "thread", taskId: null },
    query: "retry",
    index: 0,
    focus: 1,
    matches: 1,
    counting: false,
    hit: { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
  };
  const view = await mount(timelineView(messages, "idle", undefined, undefined, find));

  assert.equal(query(view.container, ".work-steps pre").textContent, "retry the build");

  await view.render(timelineView(messages, "idle", undefined, undefined, { ...find, hit: null, matches: 0, query: "" }));
  assert.equal(view.container.querySelector(".work-steps"), null, "the fold closes again once the match is no longer being read");
  await view.unmount();
});

test("a running turn collapses its tool calls behind the newest one", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "tool", text: "Read", detail: "three" },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Read");
  assert.equal(query(run, ".work-count").textContent, "+2");
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
  assert.equal(view.container.querySelectorAll(".work-steps").length, 0);

  await expand(run);
  assert.deepEqual([...view.container.querySelectorAll(".work-steps .work-row .work-tool")].map((step) => step.textContent), ["Bash", "Grep", "Read"]);
  await view.unmount();
});

test("a run of tool calls leads with the argument, not the tool name", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "git status --short" }) },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "yarn tsc --noEmit" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "$yarn tsc --noEmit");

  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["$git status --short", "$yarn tsc --noEmit"]);
  assert.equal(run.querySelector(".work-row .work-tool"), null, "a run of one tool names it once, in its own summary");
  await view.unmount();
});

test("a run of mixed tools names the tool on every call", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Read", detail: JSON.stringify({ file_path: "/repo/src/renderer/styles.css" }) },
    { kind: "tool", text: "Grep", detail: JSON.stringify({ pattern: "work-row", path: "src/renderer" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-tool")].map((step) => step.textContent), ["Read", "Grep"]);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["…/renderer/styles.css", "work-row in src/renderer"]);
  await view.unmount();
});

test("a settled turn folds its steps behind the final answer", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Fixed the race." },
  );
  const view = await mount(timelineView(messages, "idle"));

  const settled = query<HTMLDetailsElement>(view.container, ".work-group");
  assert.equal(query(settled, ".work-summary").textContent, "3 steps");
  assert.equal(query(view.container, ".message.turn > .message-text").textContent, "Fixed the race.");
  assert.equal(view.container.querySelector(".work-note"), null);

  await expand(settled);
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Grep");
  assert.equal(query(run, ".work-count").textContent, "+1");

  await view.unmount();
});

test("timeline groups keep user turns apart and leave a lone answer uncollapsed", () => {
  const messages = transcript(
    { kind: "user", text: "One" },
    { kind: "assistant", text: "Sure." },
    { kind: "user", text: "Two" },
    { kind: "assistant", text: "Checking." },
    { kind: "tool", text: "Bash" },
  );

  const settled = groupTimeline(messages, { running: false });
  assert.deepEqual(settled.map((group) => group.kind), ["message", "turn", "message", "turn"]);
  assert.deepEqual(settled[1], { kind: "turn", id: "m1", steps: [], final: messages[1], endsAt: messages[1].at, live: false });
  const settledTurn = item(settled[3]);
  if (settledTurn.kind !== "turn") assert.fail("expected the last settled group to be a turn");
  assert.equal(settledTurn.final, null);
  assert.equal(settledTurn.steps.length, 2);

  const running = groupTimeline(messages, { running: true });
  const earlierTurn = item(running[1]);
  const liveTurn = item(running[3]);
  if (earlierTurn.kind !== "turn" || liveTurn.kind !== "turn") assert.fail("expected grouped turns");
  assert.equal(earlierTurn.live, false);
  assert.equal(liveTurn.live, true);
});

test("a settled turn times each step it folds away", async () => {
  const settledMessages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "Looking." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Done." },
  );
  const settledView = await mount(timelineView(settledMessages, "idle"));

  const settled = query<HTMLDetailsElement>(settledView.container, ".work-group");
  assert.equal(query(settled, ".work-time").textContent, "3s");
  await expand(settled);
  const run = query<HTMLDetailsElement>(settledView.container, ".work-run");
  assert.equal(query(run, ".work-time").textContent, "2s");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-time")].map((time) => time.textContent), ["1s", "1s"]);
  await settledView.unmount();
});

test("a running turn counts up until its work ends", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await act(async () => { vi.advanceTimersByTime(4_000); });
  assert.equal(elapsed(), "1m 4s");

  await view.render(timelineView([...running, { id: "l2", at: 106_000, kind: "assistant", text: "Done." }], "idle"));
  assert.equal(elapsed(), "1m 6s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 6s");

  await view.unmount();
});

test("a stopped turn freezes at the moment its run ended", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await view.render(timelineView(running, "stopped", null, 102_000));
  assert.equal(elapsed(), "1m 2s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 2s", "stopping ends the turn even though no answer closed it");

  await view.render(timelineView(running, "stopped", null));
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "55s", "work stored before stops were timed rests on its last step");

  await view.unmount();
});

test("elapsed labels stay readable from seconds to hours", async () => {
  const { formatElapsed } = await import("../../src/renderer/components/ConversationTimeline.tsx");

  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(940), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_500_000), "2h 5m");
});

test("a thread waiting on its checkout says so in the transcript, and its composer holds", async () => {
  window.desktop = fakeDesktop();
  const messages = transcript({ kind: "user", text: "Refactor the loader" });

  const view = await mount(timelineView(messages, "idle"));
  assert.equal(view.container.querySelector(".waiting-row"), null, "an idle thread is not waiting on anything");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "worktree"));
  const waiting = query(view.container, ".waiting-row");
  assert.match(waiting.textContent, /Creating worktree/);
  assert.equal(waiting.getAttribute("role"), "status", "the wait is announced rather than only drawn");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "run"));
  assert.match(query(view.container, ".waiting-row").textContent, /Starting/);
  await view.unmount();
});
