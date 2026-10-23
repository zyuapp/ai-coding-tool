import { type TimelineProps, type TimelineMessageSeed, transcript } from "../support/timeline.mts";
import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi, onTestFinished } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";

import { fireResizeObservers, item, mount, rowHeights } from "../support/renderer-dom.mts";

const { ConversationTimeline, READING_SETTLE_MS } = await import("../../src/renderer/components/ConversationTimeline.tsx");

type TimelineReadingPoint = Parameters<NonNullable<TimelineProps["onReadingPointMove"]>>[0];
type ThreadMountedView = Awaited<ReturnType<typeof mount>>;

const BOTTOM = 4000;

function threadHarness() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  /** The reader's pauses between gestures, which the real clock running the test never has. */
  let paused = 0;
  const now = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + paused);
  onTestFinished(() => { clock.mockRestore(); });
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
  /** The transcript laid out from the top of the scroller, each row where the virtualizer put it, so a row is found where it was read. */
  const layout = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>(".timeline-row");
    const shift = this.classList.contains("timeline") ? 0 : row ? Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? 0) : null;
    const top = shift === null ? 0 : shift - offset;
    return { x: 0, y: top, top, left: 0, right: 860, bottom: top, width: 860, height: 0, toJSON: () => ({}) };
  });
  onTestFinished(() => { layout.mockRestore(); });
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  /** What the workspace would hold, fed back in as each thread is opened. */
  const points: Record<string, TimelineReadingPoint> = {};
  const moves: Array<{ id: string; point: TimelineReadingPoint }> = [];
  /**
   * `loading` is a thread whose transcript is still on disk, which the workspace marks by its summary.
   * `tools` are calls a running thread has made since its last message. `match` is the message find is showing.
   */
  const thread = (id: string, count: number, prefix?: string, loading = false, tools = 0, match?: string) => {
    const currentThread: Thread = {
      id, title: id, engine: "claude", executionPolicy: "confirm", continuationStatus: "none", updatedAt: 1,
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      messages: transcript(
        ...Array.from({ length: count }, (_, index): TimelineMessageSeed => ({
          kind: index % 2 === 0 ? "user" : "assistant",
          text: `${id} ${index}`,
        })),
        ...Array.from({ length: tools }, (_, index): TimelineMessageSeed => ({ kind: "tool", text: "Bash", detail: `${id} step ${index}` })),
      )
        .map((message, index) => (prefix ? { ...message, id: `${prefix}${index}` } : message)),
      ...(loading ? { messages: [], historySummary: { messageCount: count, attachmentCount: 0 } } : {}),
    };
    return React.createElement(ConversationTimeline, {
      currentThread,
      engine: "claude",
      engineLabel: "Claude",
      folder: "/p", status: tools > 0 ? "running" : "idle", compacting: false, waitingOn: null, scrollContainerRef,
      readingPoint: points[id] ?? null,
      ...(match ? { find: {
        target: { kind: "thread", taskId: null }, query: "x", index: 0, focus: 1, matches: 1, counting: false,
        hit: { messageId: match, field: "text", start: 0, occurrence: 0 },
      } satisfies NonNullable<TimelineProps["find"]> } : {}),
      onReadingPointMove: (point: TimelineReadingPoint) => { points[id] = point; moves.push({ id, point }); },
    });
  };
  /** The reader moving the view themselves, which is a scroll with one of their gestures behind it. */
  const scrollTo = async (top: number) => {
    paused += 1000;
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** A key pressed with focus left on the page, which is where a click on the transcript's text leaves it. */
  const press = async (key: string) => {
    paused += 1000;
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  };
  /** The reader's last gesture still going, the way a trackpad's momentum outlasts the hand on it. */
  const coastTo = async (top: number) => {
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
    /** The reader's hand off the view long enough that nothing they did is still moving it. */
    rest: () => { paused += 1000; },
    scroller,
    scrolls,
    points,
    moves,
    thread,
    scrollTo,
    coastTo,
    press,
    correctTo,
    settle,
    resize,
    done: async (view: ThreadMountedView) => { await view.unmount(); scroller.remove(); },
  };
}

test("a thread reopens where its reader left it, and one left at the foot reopens there", async () => {
  const { scroller, scrolls, thread, scrollTo, settle, done } = threadHarness();

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

  await view.render(thread("foot", 12));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900, "a thread left at its foot reopens there");

  await done(view);
});

test("a thread left at its foot that gained output while away reopens at the exact place, not the new foot", async () => {
  const { scroller, scrolls, points, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);
  await view.render(thread("other", 12, "o"));
  await settle();
  assert.ok(points["foot"], "a thread left at its foot keeps the place it was read at");

  /** Two more messages make the transcript longer than the reader saw it. */
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: BOTTOM + 1000 });
  scrolls.length = 0;
  await view.render(thread("foot", 14));
  await settle();
  assert.ok(!scrolls.includes(BOTTOM + 1000), "the new foot is not where the reader was");
  assert.equal(scroller.scrollTop, BOTTOM - 900, "the view sits where the reader left it");

  await done(view);
});

test("a place left at the foot stays put when output from while away measures in after the thread reopens", async () => {
  const { scroller, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("foot", 12));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900);

  /** A row from while away measures taller once the thread is back on screen. */
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: BOTTOM + 27 });
  await resize();
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900, "the view stays where the reader left it");

  await done(view);
});

test("new output on a reopened thread leaves the place its reader left alone", async () => {
  const { scrolls, points, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();
  const left = item(points["read"]);

  await view.render(thread("read", 12, undefined, false, 1));
  await settle();
  scrolls.length = 0;
  await view.render(thread("read", 12, undefined, false, 2));
  await settle();
  await resize();
  assert.ok(!scrolls.includes(BOTTOM), "a tool call does not send the reader to the foot");

  await view.render(thread("other", 12, "o"));
  await settle();
  assert.deepEqual(points["read"], left, "the place the reader left is still the one kept");

  await done(view);
});

test("new output follows a view at the foot, and a thread never opened opens there", async () => {
  const { scrolls, thread, settle, resize, done } = threadHarness();

  const view = await mount(thread("fresh", 12, undefined, false, 1));
  await settle();
  assert.equal(scrolls.at(-1), BOTTOM, "a thread never opened before opens at its foot");

  scrolls.length = 0;
  await view.render(thread("fresh", 12, undefined, false, 2));
  await settle();
  await resize();
  assert.equal(scrolls.at(-1), BOTTOM, "a tool call keeps a view at the foot there");

  /** Reopened with nothing new, the place its reader left is the foot, which goes on following. */
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("fresh", 12, undefined, false, 2));
  await settle();
  scrolls.length = 0;
  await view.render(thread("fresh", 12, undefined, false, 3));
  await settle();
  await resize();
  assert.equal(scrolls.at(-1), BOTTOM, "a thread reopened at its foot follows its next tool call");

  await done(view);
});

test("a reopened place in sight of the foot follows new output the way the foot does", async () => {
  const { scroller, scrolls, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("near", 12, undefined, false, 1));
  await settle();
  await scrollTo(BOTTOM - 960);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("near", 12, undefined, false, 1));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 960, "the place reopens exactly where it was left");

  scrolls.length = 0;
  await view.render(thread("near", 12, undefined, false, 2));
  await settle();
  await resize();
  assert.equal(scrolls.at(-1), BOTTOM, "a tool call takes a view left at the foot along with it");

  await done(view);
});

test("a place left at the foot follows new output when the window grew while away", async () => {
  const { scroller, scrolls, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("foot", 12, undefined, false, 1));
  await settle();
  await scrollTo(BOTTOM - 900);
  await view.render(thread("other", 12, "o"));
  await settle();

  /** A taller window has less to scroll, so the place left is past where the scroller can go. */
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 1000 });
  await view.render(thread("foot", 12, undefined, false, 1));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 1000);

  scrolls.length = 0;
  await view.render(thread("foot", 12, undefined, false, 2));
  await settle();
  await resize();
  assert.equal(scrolls.at(-1), BOTTOM, "the next tool call is followed");

  await done(view);
});

test("a view hidden behind another tab reopens where its reader left it", async () => {
  const { scroller, scrolls, thread, scrollTo, settle, resize, done } = threadHarness();
  const hide = async (hidden: boolean) => {
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: hidden ? 0 : 900 });
    await resize();
    await settle();
  };

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();
  await hide(true);
  await hide(false);
  assert.equal(scroller.scrollTop, 300, "a reopened place survives its tab being hidden");

  await view.render(thread("tail", 12, undefined, false, 1));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900);
  await hide(true);
  /** Output that lands while the tab is hidden makes the transcript longer than the reader saw it. */
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: BOTTOM + 1000 });
  await view.render(thread("tail", 12, undefined, false, 2));
  await settle();
  scrolls.length = 0;
  await hide(false);
  assert.ok(!scrolls.includes(BOTTOM + 1000), "the new foot is not where the reader was");
  assert.equal(scroller.scrollTop, BOTTOM - 900, "a tab left at its foot reopens at that place");

  await done(view);
});

test("a thread left while scrolling to its end reopens at the end", async () => {
  const { scroller, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  /** A smooth scroll is still on its way when the reader switches threads. */
  const instant = scroller.scrollTo;
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: () => {} });
  await act(async () => { view.container.querySelector<HTMLButtonElement>(".scroll-to-end")?.click(); });
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: instant });
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900);

  await done(view);
});

test("a prompt the reader sends hands a reopened place to its answer", async () => {
  const { scroller, scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();
  assert.equal(scroller.scrollTop, 300);

  scrolls.length = 0;
  await view.render(thread("read", 13));
  await settle();
  assert.equal(scrolls.at(-1), BOTTOM, "the prompt sent is brought into view");

  scrolls.length = 0;
  await view.render(thread("read", 14));
  await settle();
  assert.ok(scrolls.length > 0 && !scrolls.includes(BOTTOM), "its answer is followed from its first line");

  await done(view);
});

test("a place adopted while the thread is on screen is the one kept when the reader leaves", async () => {
  const { points, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(900);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  const later = item(points["read"]);
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();

  /** A newer report for this thread arrives after it reopened from an older one. */
  points["read"] = later;
  await view.render(thread("read", 12));
  await settle();
  await view.render(thread("other", 12, "o"));
  await settle();
  assert.deepEqual(points["read"], later, "leaving does not put the older place back");

  await done(view);
});

test("the match find took the reader to is where the thread reopens", async () => {
  const { rest, scroller, points, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 40));
  await settle();
  await scrollTo(300);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  const before = item(points["read"]);
  rest();

  await view.render(thread("read", 40, undefined, false, 0, "m30"));
  await settle();
  const found = scroller.scrollTop;
  assert.notEqual(found, 300, "find moved the view to its match");
  await view.render(thread("read", 40));
  await view.render(thread("other", 12, "o"));
  await settle();
  assert.notDeepEqual(points["read"], before, "the match's place is kept");

  await view.render(thread("read", 40));
  await settle();
  assert.equal(scroller.scrollTop, found, "the thread reopens on the match");

  await done(view);
});

test("a gesture still going when a thread opens neither moves that thread nor becomes its place", async () => {
  const { scroller, points, thread, scrollTo, coastTo, settle, done } = threadHarness();

  const view = await mount(thread("foot", 12, "f"));
  await settle();
  await view.render(thread("mid", 12, "d"));
  await settle();
  await scrollTo(1200);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  const mid = item(points["mid"]);

  /** The trackpad keeps coasting on the transcript as the thread changes under it. */
  await view.render(thread("read", 12));
  await settle();
  await scrollTo(600);
  await view.render(thread("foot", 12, "f"));
  await coastTo(640);
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900, "a thread left at its foot still opens there");

  await view.render(thread("read", 12));
  await settle();
  await scrollTo(400);
  await view.render(thread("mid", 12, "d"));
  await coastTo(450);
  await settle();
  assert.equal(scroller.scrollTop, 1200, "a thread left mid-transcript still opens where it was read");

  await view.render(thread("read", 12));
  await settle();
  assert.deepEqual(points["mid"], mid, "the coasting is never kept as where the reader was");
  await view.render(thread("foot", 12, "f"));
  await settle();
  assert.equal(scroller.scrollTop, BOTTOM - 900, "nor kept for the thread opened under it");

  await done(view);
});

test("keys that scroll the transcript with focus outside it are the reader's", async () => {
  const { scroller, points, thread, scrollTo, press, correctTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();
  const left = item(points["read"]);

  /** Page Down from the page scrolls the transcript last clicked into. */
  await act(async () => { scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  await press("PageDown");
  await correctTo(1500);
  assert.equal(scroller.scrollTop, 1500);

  await view.render(thread("other", 12, "o"));
  await settle();
  assert.notDeepEqual(points["read"], left, "the place the keys took the reader to is kept");

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

test("a thread opened before its transcript loads reopens where its reader left it and keeps reporting", async () => {
  const { scrolls, moves, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("other", 12, "o"));
  await settle();

  scrolls.length = 0;
  await view.render(thread("read", 12, undefined, true));
  await settle();
  await view.render(thread("read", 12));
  await settle();
  assert.ok(scrolls.length > 0, "the loaded transcript places its view");
  assert.ok(!scrolls.includes(BOTTOM), "a thread left mid-transcript does not open at its foot once it loads");

  moves.length = 0;
  await scrollTo(500);
  await act(async () => { await vi.advanceTimersByTimeAsync(READING_SETTLE_MS); });
  assert.ok(moves.some((move) => move.id === "read" && move.point !== null), "the reader's new place is reported");

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
