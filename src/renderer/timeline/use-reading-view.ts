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

/** A scroll landing this close to the one we asked for is that scroll arriving rather than the reader moving. */
const LANDED_WITHIN = 4;

/** How long a view waits for its reader to stop moving before telling the workspace where they are. */
export const READING_SETTLE_MS = 150;

/** The refs the view is held in, shared by everything that places it. */
type ViewRefs = {
  view: RefObject<View>;
  restoreScroll: RefObject<() => void>;
  /** The one way anything scrolls the view, so every offset it asks for is one it can recognise. */
  placeAt: RefObject<(top: number, behavior?: ScrollBehavior) => void>;
  /** Where the view was last asked to sit, which tells a scroll of ours from one of the reader's. */
  placedAt: RefObject<number>;
  /** The target of a smooth scroll still on its way, which owns the events it passes on the way. */
  pendingScroll: RefObject<number | null>;
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
    placedAt: useRef(-1),
    pendingScroll: useRef<number | null>(null),
    observed: useRef<ReadingPoint>(null),
    placedFrom: useRef<ReadingPoint>(null),
  };
}

type ReadingViewOptions = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  taskId?: string;
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
export function useReadingView({ scrollContainerRef, timelineRef, virtualizer, taskId, rowOfMessage, hit, answerId, toolId, readingPoint, onReadingPointMove, setScrollMargin }: ReadingViewOptions) {
  const refs = useViewRefs();
  const { view, restoreScroll, placeAt, placedAt, pendingScroll, observed, placedFrom } = refs;
  const [atBottom, setAtBottom] = useState(true);
  /** The reading point prop, read by effects that must not re-run when it changes. */
  const incoming = useRef<ReadingPoint>(null);
  incoming.current = readingPoint ?? null;
  const rows = useRef(rowOfMessage);
  rows.current = rowOfMessage;

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
      if (!taskId) return null;
      const top = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
      return top ? { anchor: String(top.key), depth: scroller.scrollTop - top.start } : null;
    };
    /**
     * The one way anything scrolls the view. It records where it asked to sit, and an instant jump
     * confirms its own landing here — wherever no event will say so. A smooth scroll keeps its mark
     * until it lands or the browser ends it.
     */
    const settle = (top: number, behavior?: ScrollBehavior) => {
      placedAt.current = top;
      pendingScroll.current = top;
      scroller.scrollTo({ top, ...(behavior ? { behavior } : {}) });
      if (!behavior && Math.abs(scroller.scrollTop - top) <= LANDED_WITHIN) pendingScroll.current = null;
    };
    placeAt.current = settle;
    /** Hands the thread's place to the workspace once it stops moving, unless that is what it already holds. */
    const report = () => {
      clearTimeout(commitTimer);
      commitTimer = undefined;
      if (taskId && !sameReadingPoint(observed.current, placedFrom.current)) {
        placedFrom.current = observed.current;
        onReadingPointMove?.(observed.current);
      }
    };
    const reportSoon = () => {
      clearTimeout(commitTimer);
      commitTimer = setTimeout(report, READING_SETTLE_MS);
    };
    const onScrollEnd = () => {
      pendingScroll.current = null;
    };
    const onScroll = () => {
      /** Ours is a scroll that sits where we asked, or one still riding a smooth scroll home. Everything else is the reader's. */
      const landed = Math.abs(scroller.scrollTop - placedAt.current) <= LANDED_WITHIN;
      const ours = landed || pendingScroll.current !== null;
      if (landed) pendingScroll.current = null;
      const bottom = atFoot();
      setAtBottom(bottom);
      if (!ours) {
        if (bottom) view.current = FOOT;
        else view.current = { at: "rest" };
      }
      if (!taskId) return;
      observed.current = bottom ? null : observe();
      reportSoon();
    };
    const place = () => {
      const held = view.current;
      if (held.at === "foot") return settle(scroller.scrollHeight);
      if (held.at === "rest") return;
      const anchor = timeline.querySelector(`[data-message-id="${held.id}"], [data-group-id="${held.id}"]`);
      if (anchor) settle(scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + held.depth);
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
    scroller.addEventListener("scrollend", onScrollEnd);
    observer.observe(timeline);
    measure();

    /** A thread reopens where its reader left it wherever that row still exists; one whose row is gone opens at its foot. */
    placedAt.current = -1;
    pendingScroll.current = null;
    const left = taskId ? incoming.current : null;
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
      scroller.removeEventListener("scrollend", onScrollEnd);
      observer.disconnect();
    };
  }, [taskId, scrollContainerRef, virtualizer]);

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

  useFollowNewest(refs, taskId, answerId, toolId);

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
function useFollowNewest({ view, restoreScroll }: ViewRefs, taskId?: string, answerId?: string, toolId?: string) {
  /** An answer is read from its first line, so the view holds its top instead of chasing the last. */
  const answerThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = answerThread.current === taskId;
    answerThread.current = taskId;
    if (!answerId || !within || view.current.at === "rest") return;
    view.current = { at: "row", id: answerId, depth: ANSWER_DEPTH };
    restoreScroll.current();
  }, [answerId, taskId]);

  /** Work in progress is worth following, so a tool call hands the view back to the newest line. */
  const toolThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = toolThread.current === taskId;
    toolThread.current = taskId;
    if (!toolId || !within || view.current.at === "rest") return;
    view.current = FOOT;
    restoreScroll.current();
  }, [toolId, taskId]);
}
