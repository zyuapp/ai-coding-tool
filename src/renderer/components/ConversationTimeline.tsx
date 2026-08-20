import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, GitFork, ListCollapse, MessageSquareQuote, X, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { attachmentUrl } from "../../application/attachments";
import type { StreamingTail } from "../../application/task-workspace";
import type { FindView } from "../../application/workspace-state";
import type { FindHit } from "../../domain/find";
import type { Annotation, AnnotationAnchor, Task, TaskMessage } from "../../domain/task";
import { AnnotationRow } from "./AnnotationRow";
import { PasteRow } from "./PasteRow";
import { MarkdownMessage } from "./MarkdownMessage";
import { RevealedTextProvider, StreamingText } from "./StreamingText";
import { SystemNotice } from "./SystemNotice";
import { useDismissibleLayer, useModalFocus } from "../focus";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

function AttachmentViewer({ source, onClose }: { source: string; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div ref={dialog} className="viewer" role="dialog" aria-modal="true" aria-label="Screenshot" tabIndex={-1} onClick={onClose}>
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close screenshot"><X size={16} /></button>
      <img src={source} alt="Attached screenshot" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

/** The message a match is in. Whatever holds it opens, however deep the fold it was written into. */
const RevealedMessage = createContext<string | null>(null);

const MATCH_HIGHLIGHT = "find-match";
const ACTIVE_HIGHLIGHT = "find-active";
const ANNOTATION_HIGHLIGHT = "annotation-mark";
const EMPTY_ANNOTATIONS: Annotation[] = [];

/** Where a point in a message sits, counted in characters of the text nodes before it. */
function renderedOffset(root: Element, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The range those counted characters name today, or nothing while the message is off screen. */
function renderedRange(root: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && at + length >= start) {
      range.setStart(node, start - at);
      started = true;
    }
    if (started && at + length >= end) {
      range.setEnd(node, end - at);
      return range;
    }
    at += length;
  }
  return null;
}

function highlights(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

/**
 * Draws every match the rows on screen hold, and the one being read among them. The ranges are the
 * rendered text's, so markdown is highlighted where it is read rather than where it was written.
 */
function paintMatches(root: HTMLElement | null, query: string, hit: FindHit | null) {
  const registry = highlights();
  if (!registry) return;
  registry.delete(MATCH_HIGHLIGHT);
  registry.delete(ACTIVE_HIGHLIGHT);
  const needle = query.trim().toLowerCase();
  if (!root || !needle) return;
  const found: Range[] = [];
  const seen = new Map<string, number>();
  let active: Range | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase();
    if (!text) continue;
    const owner = node.parentElement?.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      found.push(range);
      if (!owner) continue;
      const occurrence = seen.get(owner) ?? 0;
      seen.set(owner, occurrence + 1);
      if (hit && owner === hit.messageId && occurrence === hit.occurrence) active = range;
    }
  }
  if (found.length) registry.set(MATCH_HIGHLIGHT, new Highlight(...found));
  if (active) registry.set(ACTIVE_HIGHLIGHT, new Highlight(active));
}

type TimelineGroup =
  | { kind: "message"; id: string; message: TaskMessage }
  | { kind: "turn"; id: string; steps: TaskMessage[]; final: TaskMessage | null; endsAt: number | null; live: boolean };

/** A step runs until the next one starts; the newest step of a live turn has not ended yet. */
type TimedStep = { message: TaskMessage; endsAt: number | null };

type TurnSegment =
  | { kind: "note"; id: string; message: TaskMessage }
  | { kind: "tools"; id: string; steps: TimedStep[] };

type TimelineOptions = { running: boolean; tailMessageId?: string; runEndedAt?: number };

function startOf(group: TimelineGroup) {
  return group.kind === "message" ? group.message.at : (group.steps[0] ?? group.final)?.at ?? null;
}

/** Only a live turn is still running; anything else ends at the newest moment known to have passed. */
function endOf(group: TimelineGroup, next: TimelineGroup | undefined, runEndedAt?: number) {
  if (group.kind !== "turn") return null;
  if (group.final) return group.final.at;
  return (next && startOf(next)) ?? (group.live ? null : runEndedAt ?? group.steps.at(-1)?.at ?? null);
}

/**
 * Assistant text and the tool calls it drives belong to one turn. A turn ending in assistant text is
 * settled; the newest turn of a running task is live and keeps collecting steps. A turn no answer
 * closed ends where the next group opens, or where the run it belonged to stopped.
 */
export function groupTimeline(messages: TaskMessage[], { running, tailMessageId, runEndedAt }: TimelineOptions): TimelineGroup[] {
  const groups: (TimelineGroup | TaskMessage[])[] = [];
  for (const message of messages) {
    if (message.kind === "user" || message.kind === "system") {
      groups.push({ kind: "message", id: message.id, message });
      continue;
    }
    const open = groups.at(-1);
    if (Array.isArray(open)) open.push(message);
    else groups.push([message]);
  }
  const liveTurn = running && Array.isArray(groups.at(-1)) ? groups.at(-1) : undefined;
  const timeline: TimelineGroup[] = groups.map((group) => {
    if (!Array.isArray(group)) return group;
    const settled = group !== liveTurn && group.at(-1)!.kind === "assistant";
    return {
      kind: "turn",
      id: group[0]!.id,
      steps: settled ? group.slice(0, -1) : group,
      final: settled ? group.at(-1)! : null,
      endsAt: null,
      live: group === liveTurn,
    } satisfies TimelineGroup;
  });
  /** Text can stream before its first block commits, so the turn it belongs to may not exist yet. */
  if (running && tailMessageId && !messages.some((message) => message.id === tailMessageId) && !liveTurn) {
    timeline.push({ kind: "turn", id: tailMessageId, steps: [], final: null, endsAt: null, live: true });
  }
  return timeline.map((group, index) => group.kind !== "turn" ? group : { ...group, endsAt: endOf(group, timeline[index + 1], runEndedAt) });
}

function timeSteps(steps: TaskMessage[], turnEndsAt: number | null): TimedStep[] {
  return steps.map((message, index) => ({ message, endsAt: steps[index + 1]?.at ?? turnEndsAt }));
}

function toSegments(steps: TimedStep[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const step of steps) {
    if (step.message.kind !== "tool") {
      segments.push({ kind: "note", id: step.message.id, message: step.message });
      continue;
    }
    const open = segments.at(-1);
    if (open?.kind === "tools") open.steps.push(step);
    else segments.push({ kind: "tools", id: step.message.id, steps: [step] });
  }
  return segments;
}

export function formatElapsed(ms: number) {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Work still in flight has no end yet, so it counts up from its start once a second. */
function Elapsed({ startedAt, endsAt }: { startedAt: number; endsAt: number | null }) {
  const [end, setEnd] = useState(() => endsAt ?? Date.now());
  useEffect(() => {
    if (endsAt !== null) {
      setEnd(endsAt);
      return;
    }
    setEnd(Date.now());
    const timer = setInterval(() => setEnd(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  return <span className="work-time">{formatElapsed(end - startedAt)}</span>;
}

/**
 * Folded work stays out of the DOM until opened, so a long turn costs one row until it is read. A
 * fold holding the match being read opens itself, because a match nobody can see is no match at all.
 */
function Fold({ className, summary, holds, messageId, children }: { className: string; summary: ReactNode; holds: string[]; messageId?: string; children: () => ReactNode }) {
  const revealed = useContext(RevealedMessage);
  const [open, setOpen] = useState(false);
  const forced = revealed !== null && holds.includes(revealed);
  const shown = open || forced;
  return (
    <details className={className} open={shown} data-message-id={messageId} onToggle={(event) => { if (!forced) setOpen(event.currentTarget.open); }}>
      <summary>{summary}</summary>
      {shown && children()}
    </details>
  );
}

function ToolStep({ step }: { step: TimedStep }) {
  const summary = (
    <>
      <span className="work-lead">Worked</span>
      <Elapsed startedAt={step.message.at} endsAt={step.endsAt} />
      <span className="work-label">{step.message.text}</span>
    </>
  );
  return <Fold className="work-row" holds={[step.message.id]} messageId={step.message.id} summary={summary}>{() => <pre>{step.message.detail}</pre>}</Fold>;
}

/** Run of tool calls: the newest one stays visible, the rest hide behind a +N counter. */
function ToolRun({ steps }: { steps: TimedStep[] }) {
  if (steps.length === 1) return <ToolStep step={steps[0]!} />;
  const hidden = steps.length - 1;
  const summary = (
    <>
      <span className="work-lead">Worked</span>
      <Elapsed startedAt={steps[0]!.message.at} endsAt={steps.at(-1)!.endsAt} />
      <span className="work-label">{steps.at(-1)!.message.text}</span>
      <span className="work-count" aria-label={`${hidden} earlier tool ${hidden === 1 ? "call" : "calls"}`}>+{hidden}</span>
    </>
  );
  return (
    <Fold className="work-group" holds={steps.map((step) => step.message.id)} summary={summary}>
      {() => <div className="work-steps">{steps.map((step) => <ToolStep key={step.message.id} step={step} />)}</div>}
    </Fold>
  );
}

/**
 * A live turn types its newest text out. The tail can arrive before its first block commits, so it
 * renders under the message id it will belong to and keeps that node once the block lands. The
 * newest text stays streamed even between tails, because remounting it would replay the whole block.
 */
function TurnSegments({ segments, tail, live = false }: { segments: TurnSegment[]; tail?: StreamingTail | null; live?: boolean }) {
  const newest = segments.at(-1);
  const streamingId = live ? tail?.messageId ?? (newest?.kind === "note" ? newest.message.id : undefined) : undefined;
  const nodes = segments.map((segment) => segment.kind === "tools"
    ? <ToolRun key={segment.id} steps={segment.steps} />
    : (
      <div key={segment.id} data-message-id={segment.message.id} className="message-text markdown-body work-note">
        {segment.message.id === streamingId
          ? <StreamingText id={segment.message.id} committed={segment.message.text} tail={tail?.messageId === segment.message.id ? tail.text : ""} streaming />
          : <MarkdownMessage>{segment.message.text}</MarkdownMessage>}
      </div>
    ));
  if (streamingId && !segments.some((segment) => segment.kind === "note" && segment.message.id === streamingId)) {
    nodes.push(
      <div key={streamingId} data-message-id={streamingId} className="message-text markdown-body work-note">
        <StreamingText id={streamingId} committed="" tail={tail?.text ?? ""} streaming />
      </div>,
    );
  }
  return nodes;
}

/** Settled turn: every step, tool calls and interim text alike, folds behind one row. */
function SettledSteps({ steps, endsAt }: { steps: TaskMessage[]; endsAt: number | null }) {
  const summary = (
    <>
      <span className="work-lead">Worked</span>
      <Elapsed startedAt={steps[0]!.at} endsAt={endsAt} />
      <span className="work-summary">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
    </>
  );
  return (
    <Fold className="work-group" holds={steps.map((step) => step.id)} summary={summary}>
      {() => <div className="work-steps"><TurnSegments segments={toSegments(timeSteps(steps, endsAt))} /></div>}
    </Fold>
  );
}

export type ConversationTimelineProps = {
  currentTask?: Task;
  folder: string;
  status: "idle" | "running" | "stopped";
  compacting: boolean;
  streamingTail?: StreamingTail | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  empty?: { icon: LucideIcon; title: string; description: string };
  /** Shown under the empty state, where a thread that does not exist yet is set up. */
  startOptions?: ReactNode;
  /** The find bar, when it is this transcript being searched, and the match it is showing. */
  find?: FindView | null;
  /** This composer's drafted annotations, whose anchors are highlighted and numbered here. */
  annotations?: Annotation[];
  /** Offered on selected assistant text: annotate into this transcript's composer. */
  onAnnotateAdd?: (draft: { quote: string; note: string; anchor: AnnotationAnchor }) => void;
  onAnnotateNote?: (annotationId: string, note: string) => void;
  onAnnotateRemove?: (annotationId: string) => void;
  /** Offered next to it when this transcript can hand a selection to a side chat as a bare reference. */
  onAnnotateSide?: (quote: string) => void;
};

export function ConversationTimeline({ currentTask, folder, status, compacting, streamingTail, scrollContainerRef, empty, startOptions, find, annotations = EMPTY_ANNOTATIONS, onAnnotateAdd, onAnnotateNote, onAnnotateRemove, onAnnotateSide }: ConversationTimelineProps) {
  const messages = currentTask?.messages ?? [];
  const timelineRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ quote: string; anchor: AnnotationAnchor; x: number; y: number } | null>(null);
  /** The note being written or rewritten at a highlight: for a new annotation, or an existing one. */
  const [noting, setNoting] = useState<{ annotationId?: string; quote: string; anchor: AnnotationAnchor; note: string; x: number; y: number } | null>(null);
  const selectionToolbar = useRef<HTMLDivElement>(null);
  const noteEditor = useRef<HTMLDivElement>(null);
  const noteReturn = useRef<HTMLElement>(null);
  useDismissibleLayer(selection !== null && noting === null, [selectionToolbar], () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, null);
  useDismissibleLayer(noting !== null, [noteEditor], () => setNoting(null), noteReturn);
  const [markers, setMarkers] = useState<{ id: string; number: number; x: number; y: number }[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const pinnedToBottom = useRef(true);
  /** Set once the reader scrolls for themselves, which stops the transcript taking the view back. */
  const detached = useRef(false);
  /** A message whose top is held at the top of the view, rather than following the newest line. */
  const anchored = useRef<string | null>(null);
  const restoreScroll = useRef<() => void>(() => {});
  const lastMessage = messages.at(-1);
  /** The answer being read out, whether it is still streaming or has already finished. */
  const answerId = streamingTail?.messageId ?? (lastMessage?.kind === "assistant" ? lastMessage.id : undefined);
  const toolId = lastMessage?.kind === "tool" ? lastMessage.id : undefined;
  const groups = useMemo(
    () => groupTimeline(messages, { running: status === "running", tailMessageId: streamingTail?.messageId, runEndedAt: currentTask?.runEndedAt }),
    [messages, status, streamingTail?.messageId, currentTask?.runEndedAt],
  );
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const group = groups[index];
      if (group?.kind === "turn") return group.final ? 140 : 64;
      return group?.message.kind === "user" ? 88 : 64;
    },
    getItemKey: (index) => groups[index]?.id ?? index,
    overscan: 6,
  });

  /** Which row a message is in, so a match can be scrolled to whether or not its row is drawn. */
  const rowOfMessage = useMemo(() => {
    const rows = new Map<string, number>();
    groups.forEach((group, index) => {
      if (group.kind === "message") rows.set(group.message.id, index);
      else {
        for (const step of group.steps) rows.set(step.id, index);
        if (group.final) rows.set(group.final.id, index);
      }
    });
    return rows;
  }, [groups]);

  const hit = find?.hit ?? null;
  const rendered = virtualizer.getVirtualItems().map((item) => item.key).join(",");

  /** Reading a match takes the view over, the way scrolling by hand does. */
  useEffect(() => {
    if (!hit) return;
    const row = rowOfMessage.get(hit.messageId);
    if (row === undefined) return;
    detached.current = true;
    pinnedToBottom.current = false;
    anchored.current = null;
    virtualizer.scrollToIndex(row, { align: "center" });
  }, [hit?.messageId, hit?.occurrence, rowOfMessage]);

  useEffect(() => {
    paintMatches(timelineRef.current, find?.query ?? "", hit);
  }, [find?.query, hit?.messageId, hit?.occurrence, rendered]);

  useEffect(() => () => paintMatches(null, "", null), []);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const timeline = timelineRef.current;
    if (!scroller || !timeline || typeof ResizeObserver === "undefined") return;
    pinnedToBottom.current = true;
    detached.current = false;
    anchored.current = null;
    setAtBottom(true);
    let frame = 0;
    const onScroll = () => {
      const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      pinnedToBottom.current = bottom;
      if (bottom) detached.current = false;
      setAtBottom(bottom);
    };
    /** Only a gesture means the reader took over; our own scrolling also fires scroll events. */
    const onGesture = () => {
      detached.current = true;
      anchored.current = null;
    };
    const place = () => {
      const anchor = anchored.current && timeline.querySelector(`[data-message-id="${anchored.current}"]`);
      if (anchor) {
        scroller.scrollTo({ top: scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 });
        return;
      }
      if (pinnedToBottom.current) scroller.scrollTo({ top: scroller.scrollHeight });
    };
    restoreScroll.current = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer = new ResizeObserver(() => restoreScroll.current());
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onGesture, { passive: true });
    scroller.addEventListener("touchmove", onGesture, { passive: true });
    observer.observe(timeline);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onGesture);
      scroller.removeEventListener("touchmove", onGesture);
      observer.disconnect();
    };
  }, [currentTask?.id, scrollContainerRef]);

  /** An answer is read from its first line, so the view holds its top instead of chasing the last. */
  useEffect(() => {
    if (!answerId || detached.current) return;
    anchored.current = answerId;
    restoreScroll.current();
  }, [answerId]);

  /** Work in progress is worth following, so a tool call hands the view back to the newest line. */
  useEffect(() => {
    if (!toolId) return;
    anchored.current = null;
    if (!detached.current) pinnedToBottom.current = true;
    restoreScroll.current();
  }, [toolId]);

  /** Selected assistant text grows an annotate popover; anything else puts it away. */
  useEffect(() => {
    if (!onAnnotateAdd) return;
    let frame = 0;
    const read = () => {
      const root = timelineRef.current;
      const selected = window.getSelection();
      if (!root || !selected || selected.isCollapsed || selected.rangeCount === 0) return setSelection(null);
      const quote = selected.toString().trim();
      if (!quote) return setSelection(null);
      const range = selected.getRangeAt(0);
      /** A highlight lives in one message, so a selection is only offered within a single one. */
      const messageOf = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element || !root.contains(element) || !element.closest(".message.assistant")) return null;
        return element.closest("[data-message-id]");
      };
      const startMessage = messageOf(range.startContainer);
      if (!startMessage || startMessage !== messageOf(range.endContainer)) return setSelection(null);
      const messageId = startMessage.getAttribute("data-message-id");
      if (!messageId) return setSelection(null);
      const rect = range.getBoundingClientRect();
      setSelection({
        quote,
        anchor: {
          messageId,
          start: renderedOffset(startMessage, range.startContainer, range.startOffset),
          end: renderedOffset(startMessage, range.endContainer, range.endOffset),
        },
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.shiftKey) settle();
    };
    document.addEventListener("pointerup", settle);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", settle);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [onAnnotateAdd]);

  /** Popovers sit where the selection was, so any scroll puts them away rather than leaving them adrift. */
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !onAnnotateAdd) return;
    const dismiss = () => {
      setSelection((current) => (current ? null : current));
      setNoting((current) => (current ? null : current));
    };
    scroller.addEventListener("scroll", dismiss, { passive: true });
    return () => scroller.removeEventListener("scroll", dismiss);
  }, [onAnnotateAdd, scrollContainerRef, currentTask?.id]);

  /** Anchored annotations are painted as highlights, each with a numbered marker at its end. */
  useEffect(() => {
    const registry = highlights();
    const timeline = timelineRef.current;
    registry?.delete(ANNOTATION_HIGHLIGHT);
    const ranges: Range[] = [];
    const placed: { id: string; number: number; x: number; y: number }[] = [];
    if (timeline) {
      const timelineRect = timeline.getBoundingClientRect();
      annotations.forEach((annotation, index) => {
        if (!annotation.anchor) return;
        const root = timeline.querySelector(`[data-message-id="${annotation.anchor.messageId}"]`);
        const range = root && renderedRange(root, annotation.anchor.start, annotation.anchor.end);
        if (!range) return;
        ranges.push(range);
        const rects = range.getClientRects();
        const tail = rects[rects.length - 1] ?? range.getBoundingClientRect();
        placed.push({ id: annotation.id, number: index + 1, x: tail.right - timelineRect.left, y: tail.top - timelineRect.top });
      });
    }
    if (registry && ranges.length) registry.set(ANNOTATION_HIGHLIGHT, new Highlight(...ranges));
    /** Placements repeat far more often than they move, so an unchanged set is not a render. */
    setMarkers((current) => {
      const same = current.length === placed.length && current.every((marker, index) => {
        const next = placed[index];
        return marker.id === next.id && marker.number === next.number && marker.x === next.x && marker.y === next.y;
      });
      return same ? current : placed;
    });
    return () => {
      registry?.delete(ANNOTATION_HIGHLIGHT);
    };
  }, [annotations, rendered, messages.length]);

  function openNote(selected: NonNullable<typeof selection>) {
    setNoting({ quote: selected.quote, anchor: selected.anchor, note: "", x: selected.x, y: selected.y });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function referToSide(selected: NonNullable<typeof selection>) {
    onAnnotateSide?.(selected.quote);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function commitNote(noted: NonNullable<typeof noting>) {
    if (noted.annotationId) onAnnotateNote?.(noted.annotationId, noted.note);
    else onAnnotateAdd?.({ quote: noted.quote, note: noted.note, anchor: noted.anchor });
    setNoting(null);
  }

  if (!currentTask?.messages.length && !streamingTail) {
    const EmptyIcon = empty?.icon;
    return (
      <div className="empty-state">
        <div className="empty-glyph">{EmptyIcon ? <EmptyIcon /> : <FolderIcon />}</div>
        <h2>{empty?.title ?? "Start a task"}</h2>
        <p>{empty?.description ?? (folder ? "Tell Claude what you want to change, investigate, or build in this project." : "Ask a question or start a self-contained task.")}</p>
        {startOptions}
      </div>
    );
  }

  return (
    <RevealedTextProvider flush={status === "stopped"}>
    <RevealedMessage.Provider value={hit?.messageId ?? null}>
    <div className="timeline" ref={timelineRef}>
      <div className="timeline-items" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const group = groups[item.index]!;
          const message = group.kind === "message" ? group.message : null;
          return (
            <div
              className={`timeline-row ${message?.kind ?? "turn"}`}
              data-index={item.index}
              data-message-id={message?.id}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {group.kind === "turn" ? (
                <article className="message assistant turn">
                  {group.live
                    ? <TurnSegments segments={toSegments(timeSteps(group.steps, null))} tail={streamingTail} live />
                    : group.steps.length > 0 && <SettledSteps steps={group.steps} endsAt={group.endsAt} />}
                  {group.final && <div data-message-id={group.final.id} className="message-text markdown-body"><StreamingText id={group.final.id} committed={group.final.text} /></div>}
                </article>
              ) : message!.kind === "system" ? (
                <SystemNotice message={message!} />
              ) : (
                <article className="message user">
                  <div className="message-stack">
                    {message!.annotations?.length ? <AnnotationRow annotations={message!.annotations} /> : null}
                    {message!.pastes?.length ? <PasteRow pastes={message!.pastes} /> : null}
                    {message!.attachments?.length ? (
                      <div className="message-attachments">
                        {message!.attachments.map((file, index) => (
                          <button
                            type="button"
                            key={file}
                            className="message-attachment"
                            aria-label={`View screenshot ${index + 1}`}
                            onClick={() => setViewing(attachmentUrl(file))}
                          >
                            <img src={attachmentUrl(file)} alt="" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {message!.detail && <div className="message-origin">{message!.detail}</div>}
                    {message!.text && <div className="message-text">{message!.text}</div>}
                  </div>
                </article>
              )}
            </div>
          );
        })}
      </div>
      {markers.map((marker) => (
        <button
          type="button"
          key={marker.id}
          className="annotation-marker"
          style={{ left: marker.x, top: marker.y }}
          aria-label={`Edit annotation ${marker.number}`}
          onClick={(event) => {
            const annotation = annotations.find((item) => item.id === marker.id);
            if (!annotation?.anchor) return;
            const rect = event.currentTarget.getBoundingClientRect();
            noteReturn.current = event.currentTarget;
            setNoting({ annotationId: annotation.id, quote: annotation.quote, anchor: annotation.anchor, note: annotation.note, x: rect.left + rect.width / 2, y: rect.top });
          }}
        >
          {marker.number}
        </button>
      ))}
      {status === "running" && compacting && (
        <div className="compacting-row" role="status" aria-live="polite">
          <ListCollapse aria-hidden="true" />
          <span>Compacting messages…</span>
          <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      {status === "running" && !compacting && (
        <div className="thinking-row">
          <span /> <span /> <span />
        </div>
      )}
      {!atBottom && (
        <div className="scroll-to-end-dock">
        <button
          type="button"
          className="scroll-to-end"
          aria-label="Scroll to the latest message"
          onClick={() => {
            const scroller = scrollContainerRef.current;
            if (!scroller) return;
            detached.current = false;
            anchored.current = null;
            pinnedToBottom.current = true;
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
          }}
        >
          <ChevronDown size={17} aria-hidden="true" />
        </button>
        </div>
      )}
      {viewing && <AttachmentViewer source={viewing} onClose={() => setViewing(null)} />}
      {selection && !noting && onAnnotateAdd && createPortal(
        <div ref={selectionToolbar} className="annotate-popover" role="toolbar" aria-label="Annotate selection" style={{ left: selection.x, top: selection.y }}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { noteReturn.current = event.currentTarget; openNote(selection); }}>
            <MessageSquareQuote size={14} aria-hidden="true" />Add to chat
          </button>
          {onAnnotateSide && (
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => referToSide(selection)}>
              <GitFork size={14} aria-hidden="true" />Add to side chat
            </button>
          )}
        </div>,
        document.body,
      )}
      {noting && createPortal(
        <div ref={noteEditor} className="annotate-editor" role="dialog" aria-label={noting.annotationId ? "Edit annotation" : "New annotation"} style={{ left: noting.x, top: noting.y }}>
          <input
            autoFocus
            value={noting.note}
            placeholder="Annotate…"
            onChange={(event) => setNoting({ ...noting, note: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitNote(noting);
              if (event.key === "Escape") {
                event.preventDefault();
                setNoting(null);
              }
            }}
          />
          {noting.annotationId && (
            <button
              type="button"
              aria-label="Remove annotation"
              onClick={() => {
                onAnnotateRemove?.(noting.annotationId!);
                setNoting(null);
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
    </RevealedMessage.Provider>
    </RevealedTextProvider>
  );
}
