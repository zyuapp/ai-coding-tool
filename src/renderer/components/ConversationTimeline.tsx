import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ListCollapse, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { attachmentUrl } from "../../application/attachments";
import type { StreamingTail } from "../../application/task-workspace";
import type { Task, TaskMessage } from "../../domain/task";
import { MarkdownMessage } from "./MarkdownMessage";
import { RevealedTextProvider, StreamingText } from "./StreamingText";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

function AttachmentViewer({ source, onClose }: { source: string; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Screenshot" onClick={onClose}>
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close screenshot"><X size={16} /></button>
      <img src={source} alt="Attached screenshot" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

type TimelineGroup =
  | { kind: "message"; id: string; message: TaskMessage }
  | { kind: "turn"; id: string; steps: TaskMessage[]; final: TaskMessage | null; live: boolean };

/** A step runs until the next one starts; the newest step of a live turn has not ended yet. */
type TimedStep = { message: TaskMessage; endsAt: number | null };

type TurnSegment =
  | { kind: "note"; id: string; message: TaskMessage }
  | { kind: "tools"; id: string; steps: TimedStep[] };

/**
 * Assistant text and the tool calls it drives belong to one turn. A turn ending in assistant text is
 * settled; the newest turn of a running task is live and keeps collecting steps.
 */
export function groupTimeline(messages: TaskMessage[], running: boolean, tailMessageId?: string): TimelineGroup[] {
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
      live: group === liveTurn,
    } satisfies TimelineGroup;
  });
  /** Text can stream before its first block commits, so the turn it belongs to may not exist yet. */
  if (running && tailMessageId && !messages.some((message) => message.id === tailMessageId) && !liveTurn) {
    timeline.push({ kind: "turn", id: tailMessageId, steps: [], final: null, live: true });
  }
  return timeline;
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

/** Folded work stays out of the DOM until opened, so a long turn costs one row until it is read. */
function Fold({ className, summary, children }: { className: string; summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
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
  return <Fold className="work-row" summary={summary}>{() => <pre>{step.message.detail}</pre>}</Fold>;
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
    <Fold className="work-group" summary={summary}>
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
    <Fold className="work-group" summary={summary}>
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
};

export function ConversationTimeline({ currentTask, folder, status, compacting, streamingTail, scrollContainerRef, empty }: ConversationTimelineProps) {
  const messages = currentTask?.messages ?? [];
  const timelineRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);
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
  const groups = useMemo(() => groupTimeline(messages, status === "running", streamingTail?.messageId), [messages, status, streamingTail?.messageId]);
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

  if (!currentTask?.messages.length && !streamingTail) {
    const EmptyIcon = empty?.icon;
    return (
      <div className="empty-state">
        <div className="empty-glyph">{EmptyIcon ? <EmptyIcon /> : <FolderIcon />}</div>
        <h2>{empty?.title ?? "Start a task"}</h2>
        <p>{empty?.description ?? (folder ? "Tell Claude what you want to change, investigate, or build in this project." : "Ask a question or start a self-contained task.")}</p>
      </div>
    );
  }

  return (
    <RevealedTextProvider>
    <div className="timeline" ref={timelineRef}>
      <div className="timeline-items" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const group = groups[item.index]!;
          const message = group.kind === "message" ? group.message : null;
          return (
            <div
              className={`timeline-row ${message?.kind ?? "turn"}`}
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {group.kind === "turn" ? (
                <article className="message assistant turn">
                  {group.live
                    ? <TurnSegments segments={toSegments(timeSteps(group.steps, null))} tail={streamingTail} live />
                    : group.steps.length > 0 && <SettledSteps steps={group.steps} endsAt={group.final?.at ?? null} />}
                  {group.final && <div data-message-id={group.final.id} className="message-text markdown-body"><StreamingText id={group.final.id} committed={group.final.text} /></div>}
                </article>
              ) : (
                <article className={`message ${message!.kind}`}>
                  <div className="message-stack">
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
                    {message!.kind === "user" && message!.detail && <div className="message-origin">{message!.detail}</div>}
                    {message!.text && <div className="message-text">{message!.text}</div>}
                  </div>
                </article>
              )}
            </div>
          );
        })}
      </div>
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
      )}
      {viewing && <AttachmentViewer source={viewing} onClose={() => setViewing(null)} />}
    </div>
    </RevealedTextProvider>
  );
}
