import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { sameReadingPoint, type ReadingPoint } from "../../application/workspace-state";
import type { FindHit } from "../../domain/find";

/**
 * Where the view sits. `row` holds that row `depth` pixels below the top of the view, so a negative
 * depth leaves it breathing room; `rest` is wherever the reader put it, which nothing takes back.
 */
type View = { at: "foot" } | { at: "row"; id: string; depth: number } | { at: "rest" };

const FOOT: View = { at: "foot" };

/** How far into a row an answer's first line sits, so it is not flush against the top of the view. */
const ANSWER_DEPTH = -16;

/**
 * How long a scroll after the reader's last input still belongs to that input, which carries a
 * trackpad's momentum and a held arrow key past the gaps between their events.
 */
const READER_GRIP_MS = 400;

/** A press that travels less than this is a click on the transcript rather than a drag of the view. */
const DRAG_WITHIN = 4;

/** How soon after the virtualizer scrolls itself the resulting event arrives, which it owns rather than the reader. */
const CORRECTION_WITHIN_MS = 100;

/** How long a view waits for its reader to stop moving before telling the workspace where they are. */
export const READING_SETTLE_MS = 150;

/** The refs the view is held in, shared by everything that places it. */
type ViewRefs = {
  view: RefObject<View>;
  restoreScroll: RefObject<() => void>;
  /** The one way this view scrolls itself, which leaves the reader's own scrolls to be told apart. */
  placeAt: RefObject<(top: number, behavior?: ScrollBehavior) => void>;
  /** Where this thread's reader is right now, as a reading point. */
  observed: RefObject<ReadingPoint>;
  /** The point the view was last placed from or reported, which keeps a report echoing back inert. */
  placedFrom: RefObject<ReadingPoint>;
};

function useViewRefs(): ViewRefs {
  return {
    view: useRef<View>(FOOT),
    restoreScroll: useRef<() => void>(() => {}),
    placeAt: useRef<(top: number, behavior?: ScrollBehavior) => void>(() => {}),
    observed: useRef<ReadingPoint>(null),
    placedFrom: useRef<ReadingPoint>(null),
  };
}

type ReadingViewOptions = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** When the virtualizer last scrolled this scroller to correct its own estimates. */
  virtualizerScrolledAt: RefObject<number>;
  threadId?: string;
  rowOfMessage: Map<string, number>;
  /** The match being read, if this transcript is the one being searched. */
  hit: FindHit | null;
  /** The answer being read out, whether it is still streaming or has already finished. */
  answerId?: string;
  /** The newest tool call, which is work in progress worth following. */
  toolId?: string;
  readingPoint?: ReadingPoint;
  onReadingPointMove?: (point: ReadingPoint) => void;
  /** Reports the gap above the timeline, which the virtualizer's offsets are counted from. */
  setScrollMargin: Dispatch<SetStateAction<number>>;
};

/**
 * Every scroll of this transcript: where a reopened thread lands, where a match or a fresh answer
 * takes the view, and where the reader is reported to have settled.
 */
export function useReadingView({ scrollContainerRef, timelineRef, virtualizer, virtualizerScrolledAt, threadId, rowOfMessage, hit, answerId, toolId, readingPoint, onReadingPointMove, setScrollMargin }: ReadingViewOptions) {
  const refs = useViewRefs();
  const { view, restoreScroll, placeAt, observed, placedFrom } = refs;
  const [atBottom, setAtBottom] = useState(true);
  /** The reading point prop, read by effects that must not re-run when it changes. */
  const incoming = useRef<ReadingPoint>(null);
  incoming.current = readingPoint ?? null;
  const rows = useRef(rowOfMessage);
  rows.current = rowOfMessage;
  /**
   * The thread this transcript renders right now. A switch re-renders before the effects swap over,
   * so a scroll in that gap reaches the old thread's listener while the rows under it are the new
   * thread's. Reading one against the other files a row of theirs as a place of ours.
   */
  const rendering = useRef<string | undefined>(undefined);
  rendering.current = threadId;

  /** Reading a match takes the view over, the way scrolling by hand does. */
  useEffect(() => {
    if (!hit) return;
    const row = rowOfMessage.get(hit.messageId);
    if (row === undefined) return;
    view.current = { at: "rest" };
    virtualizer.scrollToIndex(row, { align: "center" });
  }, [hit?.messageId, hit?.occurrence, rowOfMessage]);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const timeline = timelineRef.current;
    if (!scroller || !timeline || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setScrollMargin(timeline.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    /** A view with nothing below it is at the foot, as is one with nothing to scroll at all. */
    const atFoot = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;

    /** The reader's place right now, counted the way a reading point is kept. */
    const observe = (): ReadingPoint => {
      if (!threadId) return null;
      const top = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
      return top ? { anchor: String(top.key), depth: scroller.scrollTop - top.start } : null;
    };
    /** The one way this view scrolls itself. */
    const settle = (top: number, behavior?: ScrollBehavior) => {
      scroller.scrollTo({ top, ...(behavior ? { behavior } : {}) });
    };
    placeAt.current = settle;
    /** Hands the thread's place to the workspace once it stops moving, unless that is what it already holds. */
    const report = () => {
      clearTimeout(commitTimer);
      commitTimer = undefined;
      if (threadId && !sameReadingPoint(observed.current, placedFrom.current)) {
        placedFrom.current = observed.current;
        onReadingPointMove?.(observed.current);
      }
    };
    const reportSoon = () => {
      clearTimeout(commitTimer);
      commitTimer = setTimeout(report, READING_SETTLE_MS);
    };
    /**
     * A scroll is the reader's when their hand is on the view, and nothing else can say so: the
     * virtualizer corrects this same scroller by itself whenever a row measures taller than its
     * estimate, and an offset we did not ask for is that correction as often as it is the reader.
     */
    let touchedAt = -Infinity;
    let pressedAt: { x: number; y: number } | null = null;
    let dragging = false;
    const touch = () => { touchedAt = performance.now(); };
    const onPress = (event: PointerEvent) => { pressedAt = { x: event.clientX, y: event.clientY }; };
    /** A press that travels is a drag of the scrollbar or of a selection, either of which scrolls. A click does not. */
    const onPressMove = (event: PointerEvent) => {
      if (!pressedAt || dragging) return;
      if (Math.abs(event.clientX - pressedAt.x) + Math.abs(event.clientY - pressedAt.y) < DRAG_WITHIN) return;
      dragging = true;
      touch();
    };
    const onRelease = () => {
      pressedAt = null;
      if (!dragging) return;
      dragging = false;
      touch();
    };
    const readerMoving = () => dragging || performance.now() - touchedAt < READER_GRIP_MS;
    const onScroll = () => {
      if (rendering.current !== threadId) return;
      const bottom = atFoot();
      setAtBottom(bottom);
      /** The reader taking the view is the one thing that stops it being placed for them. */
      if (readerMoving()) view.current = bottom ? FOOT : { at: "rest" };
      if (!threadId) return;
      /** Where the view means to sit is what the workspace hears, so a scroll on the way there is never mistaken for the reader. */
      const held = view.current;
      if (held.at === "foot") observed.current = null;
      else if (held.at === "row") observed.current = { anchor: held.id, depth: held.depth };
      /** A view at rest is read off the scroller, so a correction the reader had no hand in is left out of it. */
      else if (readerMoving() || performance.now() - virtualizerScrolledAt.current >= CORRECTION_WITHIN_MS) observed.current = bottom ? null : observe();
      else return;
      reportSoon();
    };
    const place = () => {
      const held = view.current;
      if (held.at === "foot") return settle(scroller.scrollHeight);
      if (held.at === "rest") return;
      const anchor = timeline.querySelector(`[data-message-id="${held.id}"], [data-group-id="${held.id}"]`);
      if (anchor) return settle(scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + held.depth);
      /** A row still outside the window is fetched by index, which brings it in for the next pass to measure. */
      const row = rows.current.get(held.id);
      if (row !== undefined) settle((virtualizer.getOffsetForIndex(row, "start")?.[0] ?? scroller.scrollTop) + held.depth);
    };
    restoreScroll.current = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { place(); setAtBottom(atFoot()); });
    };
    const observer = new ResizeObserver(() => {
      measure();
      restoreScroll.current();
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", touch, { passive: true });
    scroller.addEventListener("touchmove", touch, { passive: true });
    scroller.addEventListener("keydown", touch);
    scroller.addEventListener("pointerdown", onPress);
    window.addEventListener("pointermove", onPressMove);
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
    observer.observe(timeline);
    measure();

    /** A thread reopens where its reader left it wherever that row still exists; one whose row is gone opens at its foot. */
    const left = threadId ? incoming.current : null;
    const row = left ? rows.current.get(left.anchor) : undefined;
    view.current = !left || row === undefined ? FOOT : { at: "row", id: left.anchor, depth: left.depth };
    observed.current = left;
    placedFrom.current = left;
    /** The row is brought into the window first, so `place()` has something to measure against. */
    if (row !== undefined) settle(virtualizer.getOffsetForIndex(row, "start")?.[0] ?? scroller.scrollTop);
    restoreScroll.current();
    return () => {
      cancelAnimationFrame(frame);
      report();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", touch);
      scroller.removeEventListener("touchmove", touch);
      scroller.removeEventListener("keydown", touch);
      scroller.removeEventListener("pointerdown", onPress);
      window.removeEventListener("pointermove", onPressMove);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
      observer.disconnect();
    };
  }, [threadId, scrollContainerRef, virtualizer]);

  /**
   * A report made while another thread was opening can arrive here after it. The freshest point is
   * where this thread belongs, until the reader has taken the view for themselves.
   */
  useEffect(() => {
    const point = readingPoint ?? null;
    if (sameReadingPoint(point, placedFrom.current)) return;
    placedFrom.current = point;
    if (view.current.at === "rest") return;
    const row = point ? rows.current.get(point.anchor) : undefined;
    view.current = !point || row === undefined ? FOOT : { at: "row", id: point.anchor, depth: point.depth };
    restoreScroll.current();
  }, [readingPoint]);

  useFollowNewest(refs, threadId, answerId, toolId);

  return {
    atBottom,
    /** Hands the view back to the newest line, which is where the scroll-to-end button sends it. */
    scrollToFoot: () => {
      const scroller = scrollContainerRef.current;
      if (!scroller) return;
      view.current = FOOT;
      placeAt.current(scroller.scrollHeight, "smooth");
    },
  };
}

/** What arrives while this thread is the one on screen moves the view; a switch places itself. */
function useFollowNewest({ view, restoreScroll }: ViewRefs, threadId?: string, answerId?: string, toolId?: string) {
  /** An answer is read from its first line, so the view holds its top instead of chasing the last. */
  const answerThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = answerThread.current === threadId;
    answerThread.current = threadId;
    if (!answerId || !within || view.current.at === "rest") return;
    view.current = { at: "row", id: answerId, depth: ANSWER_DEPTH };
    restoreScroll.current();
  }, [answerId, threadId]);

  /** Work in progress is worth following, so a tool call hands the view back to the newest line. */
  const toolThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = toolThread.current === threadId;
    toolThread.current = threadId;
    if (!toolId || !within || view.current.at === "rest") return;
    view.current = FOOT;
    restoreScroll.current();
  }, [toolId, threadId]);
}
