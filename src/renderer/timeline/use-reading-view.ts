import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { sameReadingPoint, type ReadingPoint } from "../../application/workspace-state";
import type { FindHit } from "../../domain/find";

/**
 * Where the view sits. `row` holds that row `depth` pixels below the top of the view, so a negative
 * depth leaves it breathing room; `kept` does the same for the place a reader left; `rest` is
 * wherever the reader or a `found` match put it, which nothing takes back.
 */
type View = { at: "foot" } | { at: "row" | "kept"; id: string; depth: number } | { at: "rest"; found?: true };

const FOOT: View = { at: "foot" };

/**
 * Whether new output moves this view: the foot and a fresh answer follow it, and so does a kept
 * place at the foot. A kept place above it and the reader's own do not.
 */
const follows = (view: View, atFoot: boolean) => view.at === "foot" || view.at === "row" || (view.at === "kept" && atFoot);

/** A reopened thread holds the place its reader left, or opens at its foot when it has none left. */
const keptView = (point: ReadingPoint, rows: Map<string, number>): View =>
  point && rows.has(point.anchor) ? { at: "kept", id: point.anchor, depth: point.depth } : FOOT;

/** How far into a row an answer's first line sits, so it is not flush against the top of the view. */
const ANSWER_DEPTH = -16;

/**
 * How long a scroll after the reader's last input still belongs to that input, which carries a
 * trackpad's momentum and a held arrow key past the gaps between their events.
 */
const READER_GRIP_MS = 400;

/** A press that travels less than this is a click on the transcript rather than a drag of the view. */
const DRAG_WITHIN = 4;

/** Input this soon after the last is the same gesture still going, like a trackpad's momentum or a held key. */
const STREAK_MS = 100;

/** Keys that scroll whatever the reader last clicked into, even with focus left on the page itself. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/** How soon after the virtualizer scrolls itself the resulting event arrives, which it owns rather than the reader. */
const CORRECTION_WITHIN_MS = 100;

/** How long a view waits for its reader to stop moving before telling the workspace where they are. */
export const READING_SETTLE_MS = 150;

/** The refs the view is held in, shared by everything that places it. */
type ViewRefs = {
  view: RefObject<View>;
  restoreScroll: RefObject<() => void>;
  /** Hands the view back to the newest line, which is where the scroll-to-end button sends it. */
  toFoot: RefObject<() => void>;
  /** Where this thread's reader is right now, as a reading point. */
  observed: RefObject<ReadingPoint>;
  /** The point the view was last placed from or reported, which keeps a report echoing back inert. */
  placedFrom: RefObject<ReadingPoint>;
  /** When the reader last gave any input, which outlives a thread switch. */
  inputAt: RefObject<number>;
  /** Whether the reader's last press landed in this scroller, which is the one the page's own keys then scroll. */
  pressedInto: RefObject<boolean>;
  /** Whether the view sat at its foot when it last moved or was placed, which is before any new output lands. */
  nearFoot: RefObject<boolean>;
};

function useViewRefs(): ViewRefs {
  return {
    view: useRef<View>(FOOT),
    restoreScroll: useRef<() => void>(() => {}),
    toFoot: useRef<() => void>(() => {}),
    observed: useRef<ReadingPoint>(null),
    placedFrom: useRef<ReadingPoint>(null),
    inputAt: useRef(-Infinity),
    pressedInto: useRef(false),
    nearFoot: useRef(true),
  };
}

type ReadingViewOptions = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  /** Whether the timeline is mounted; the view attaches to it whenever it is, including after a thread's loading state. */
  drawn: boolean;
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
  /** The newest message the user sent themselves. */
  promptId?: string;
  readingPoint?: ReadingPoint;
  onReadingPointMove?: (point: ReadingPoint) => void;
  /** Reports the gap above the timeline, which the virtualizer's offsets are counted from. */
  setScrollMargin: Dispatch<SetStateAction<number>>;
};

/**
 * Every scroll of this transcript: where a reopened thread lands, where a match or a fresh answer
 * takes the view, and where the reader is reported to have settled.
 */
export function useReadingView({ scrollContainerRef, timelineRef, drawn, virtualizer, virtualizerScrolledAt, threadId, rowOfMessage, hit, answerId, toolId, promptId, readingPoint, onReadingPointMove, setScrollMargin }: ReadingViewOptions) {
  const refs = useViewRefs();
  const { view, restoreScroll, toFoot, observed, placedFrom } = refs;
  const [atBottom, showAtBottom] = useState(true);
  const setAtBottom = (bottom: boolean) => {
    refs.nearFoot.current = bottom;
    showAtBottom(bottom);
  };
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

  useFindJump(view, virtualizer, rowOfMessage, hit);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const timeline = timelineRef.current;
    if (!scroller || !timeline || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setScrollMargin(timeline.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    /** A view with nothing below it is at the foot, as is one with nothing to scroll at all. */
    const atFoot = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;

    /** A view tucked away behind another tab has no size and no place to read. */
    const hidden = () => scroller.clientHeight === 0;

    /** The reader's place at `offset`, counted the way a reading point is kept. */
    const observe = (offset: number): ReadingPoint => {
      if (!threadId) return null;
      const top = virtualizer.getVirtualItemForOffset(offset);
      return top ? { anchor: String(top.key), depth: offset - top.start } : null;
    };
    /** Whether the view is still on its way to the foot, where its place already is. */
    let heading = false;
    const lastTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    /** Keeps the reader's place up to date. */
    const glance = () => {
      if (hidden()) return;
      if (heading && scroller.scrollTop < lastTop() - 2) return;
      heading = false;
      observed.current = observe(scroller.scrollTop);
    };
    /** The one way this view scrolls itself. */
    const settle = (top: number, behavior?: ScrollBehavior) => {
      scroller.scrollTo({ top, ...(behavior ? { behavior } : {}) });
    };
    toFoot.current = () => {
      view.current = FOOT;
      heading = true;
      observed.current = observe(lastTop());
      settle(scroller.scrollHeight, "smooth");
    };
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
    const reader = watchReader(scroller, refs);
    /** Whether this thread's view has been placed since it opened; until then the scroller still sits where the last thread left it. */
    let placed = false;
    const onScroll = () => {
      if (rendering.current !== threadId || hidden()) return;
      const moving = reader.moving();
      /** Until this thread is placed, the scroller still shows where the last one was. */
      if (placed || moving) setAtBottom(atFoot());
      /** The reader taking the view is the one thing that stops it being placed for them. */
      if (moving) {
        heading = false;
        view.current = atFoot() ? FOOT : { at: "rest" };
      }
      else if (reader.carrying() && view.current.at !== "rest") restoreScroll.current();
      if (!threadId) return;
      const held = view.current;
      /** A place being restored is what the workspace keeps, so a scroll on the way there is never mistaken for the reader. */
      if (held.at === "kept") return;
      /** A view at rest is read off the scroller, so a correction the reader had no hand in is left out of it. */
      if (held.at === "rest" && !held.found && !moving && performance.now() - virtualizerScrolledAt.current < CORRECTION_WITHIN_MS) return;
      if (held.at !== "rest" && !placed) return;
      glance();
      /** A view that places itself is heard once the reader leaves, rather than on every line it follows. */
      if (moving || held.at === "rest") reportSoon();
    };
    const place = () => {
      const held = view.current;
      if (held.at === "rest") {
        placed = true;
        return;
      }
      if (held.at === "foot") settle(scroller.scrollHeight);
      else {
        const anchor = timeline.querySelector(`[data-message-id="${held.id}"], [data-group-id="${held.id}"]`);
        if (!anchor) {
          /** A row still outside the window is fetched by index, which brings it in for the next pass to measure. */
          const row = rows.current.get(held.id);
          if (row !== undefined) settle((virtualizer.getOffsetForIndex(row, "start")?.[0] ?? scroller.scrollTop) + held.depth);
          return;
        }
        const top = scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + held.depth;
        settle(top);
      }
      placed = true;
      if (view.current.at !== "kept") glance();
    };
    /** A view hidden behind another tab is left, so it reopens where its reader last saw it rather than wherever new output took it. */
    const tuckAway = () => {
      if (view.current.at !== "kept" && observed.current) view.current = keptView(observed.current, rows.current);
      report();
    };
    restoreScroll.current = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (hidden()) return tuckAway();
        place();
        if (placed) setAtBottom(atFoot());
      });
    };
    const observer = new ResizeObserver(() => {
      measure();
      restoreScroll.current();
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(timeline);
    measure();

    /** A thread reopens exactly where its reader left it wherever that row still exists; one with no place opens at its foot. */
    const left = threadId ? incoming.current : null;
    const row = left ? rows.current.get(left.anchor) : undefined;
    view.current = keptView(left, rows.current);
    refs.nearFoot.current = view.current.at === "foot";
    observed.current = left;
    placedFrom.current = left;
    /** The row is brought into the window first, so `place()` has something to measure against. */
    if (row !== undefined) settle(virtualizer.getOffsetForIndex(row, "start")?.[0] ?? scroller.scrollTop);
    restoreScroll.current();
    return () => {
      cancelAnimationFrame(frame);
      report();
      restoreScroll.current = () => {};
      toFoot.current = () => {};
      scroller.removeEventListener("scroll", onScroll);
      reader.stop();
      observer.disconnect();
    };
  }, [threadId, drawn, scrollContainerRef, virtualizer]);

  /**
   * A report made while another thread was opening can arrive here after it. The freshest point is
   * where this thread belongs, until the reader has taken the view for themselves.
   */
  useEffect(() => {
    const point = readingPoint ?? null;
    if (sameReadingPoint(point, placedFrom.current)) return;
    placedFrom.current = point;
    if (view.current.at === "rest") return;
    observed.current = point;
    view.current = keptView(point, rows.current);
    restoreScroll.current();
  }, [readingPoint]);

  /** A transcript drawn after its loading state is opening, not receiving, so it places itself like a switch. */
  useFollowNewest(refs, drawn ? threadId : undefined, answerId, toolId, promptId);

  return {
    atBottom,
    scrollToFoot: () => toFoot.current(),
  };
}

/** Reading a match takes the view over, the way scrolling by hand does, and where it lands is the reader's place. */
function useFindJump(view: RefObject<View>, virtualizer: Virtualizer<HTMLDivElement, Element>, rowOfMessage: Map<string, number>, hit: FindHit | null) {
  useEffect(() => {
    if (!hit) return;
    const row = rowOfMessage.get(hit.messageId);
    if (row === undefined) return;
    view.current = { at: "rest", found: true };
    virtualizer.scrollToIndex(row, { align: "center" });
  }, [hit?.messageId, hit?.occurrence, rowOfMessage]);
}

/**
 * A scroll is the reader's when their hand is on the view, and nothing else can say so: the
 * virtualizer corrects this same scroller by itself whenever a row measures taller than its
 * estimate, and an offset we did not ask for is that correction as often as it is the reader.
 */
function watchReader(scroller: HTMLElement, { inputAt, pressedInto, restoreScroll }: ViewRefs) {
  let touchedAt = -Infinity;
  let pressedAt: { x: number; y: number } | null = null;
  let dragging = false;
  /**
   * A gesture still going when the thread opened was meant for the thread before it. It is put
   * back rather than taken as this reader's until it pauses.
   */
  let carried = performance.now() - inputAt.current < READER_GRIP_MS;
  const carrying = () => carried && performance.now() - inputAt.current < READER_GRIP_MS;
  const touch = () => {
    const now = performance.now();
    const streak = now - inputAt.current < STREAK_MS;
    inputAt.current = now;
    if (carrying() && streak) return restoreScroll.current();
    carried = false;
    touchedAt = now;
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (target instanceof Node && scroller.contains(target)) touch();
    else if (target === document.body && pressedInto.current && SCROLL_KEYS.has(event.key)) touch();
  };
  const onAnyPress = (event: PointerEvent) => { pressedInto.current = event.target instanceof Node && scroller.contains(event.target); };
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
  scroller.addEventListener("wheel", touch, { passive: true });
  scroller.addEventListener("touchmove", touch, { passive: true });
  scroller.addEventListener("pointerdown", onPress);
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onAnyPress, { capture: true });
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", onRelease);
  window.addEventListener("pointercancel", onRelease);
  return {
    /** Whether the reader is moving the view right now. */
    moving: () => dragging || performance.now() - touchedAt < READER_GRIP_MS,
    carrying,
    stop: () => {
      scroller.removeEventListener("wheel", touch);
      scroller.removeEventListener("touchmove", touch);
      scroller.removeEventListener("pointerdown", onPress);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onAnyPress, { capture: true });
      window.removeEventListener("pointermove", onPressMove);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
    },
  };
}

/** What arrives while this thread is the one on screen moves a view that follows; a switch places itself. */
function useFollowNewest({ view, restoreScroll, nearFoot }: ViewRefs, threadId?: string, answerId?: string, toolId?: string, promptId?: string) {
  /** The reader's own prompt hands a kept place back to the newest line, where its answer arrives. */
  const promptThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = promptThread.current === threadId;
    promptThread.current = threadId;
    if (!promptId || !within || view.current.at !== "kept") return;
    view.current = FOOT;
    restoreScroll.current();
  }, [promptId, threadId]);

  /** An answer is read from its first line, so the view holds its top instead of chasing the last. */
  const answerThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = answerThread.current === threadId;
    answerThread.current = threadId;
    if (!answerId || !within || !follows(view.current, nearFoot.current)) return;
    view.current = { at: "row", id: answerId, depth: ANSWER_DEPTH };
    restoreScroll.current();
  }, [answerId, threadId]);

  /** Work in progress is worth following, so a tool call hands the view back to the newest line. */
  const toolThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const within = toolThread.current === threadId;
    toolThread.current = threadId;
    if (!toolId || !within || !follows(view.current, nearFoot.current)) return;
    view.current = FOOT;
    restoreScroll.current();
  }, [toolId, threadId]);
}
