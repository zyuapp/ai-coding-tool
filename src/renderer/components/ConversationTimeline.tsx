import { useVirtualizer } from "@tanstack/react-virtual";
import { ListCollapse, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { attachmentUrl } from "../../application/attachments";
import type { Task, TaskMessage } from "../../domain/task";
import { MarkdownMessage } from "./MarkdownMessage";

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

type TurnSegment =
  | { kind: "note"; id: string; message: TaskMessage }
  | { kind: "tools"; id: string; messages: TaskMessage[] };

/**
 * Assistant text and the tool calls it drives belong to one turn. A turn ending in assistant text is
 * settled; the newest turn of a running task is live and keeps collecting steps.
 */
export function groupTimeline(messages: TaskMessage[], running: boolean): TimelineGroup[] {
  const turns: TaskMessage[][] = [];
  const groups: (TimelineGroup | TaskMessage[])[] = [];
  for (const message of messages) {
    if (message.kind === "user" || message.kind === "system") {
      groups.push({ kind: "message", id: message.id, message });
      continue;
    }
    const open = groups.at(-1);
    if (Array.isArray(open)) open.push(message);
    else {
      const turn = [message];
      turns.push(turn);
      groups.push(turn);
    }
  }
  const liveTurn = running ? turns.at(-1) : undefined;
  return groups.map((group) => {
    if (!Array.isArray(group)) return group;
    const settled = group !== liveTurn && group.at(-1)!.kind === "assistant";
    return {
      kind: "turn",
      id: group[0]!.id,
      steps: settled ? group.slice(0, -1) : group,
      final: settled ? group.at(-1)! : null,
      live: group === liveTurn,
    };
  });
}

function toSegments(steps: TaskMessage[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const step of steps) {
    if (step.kind !== "tool") {
      segments.push({ kind: "note", id: step.id, message: step });
      continue;
    }
    const open = segments.at(-1);
    if (open?.kind === "tools") open.messages.push(step);
    else segments.push({ kind: "tools", id: step.id, messages: [step] });
  }
  return segments;
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

function ToolStep({ message }: { message: TaskMessage }) {
  return (
    <Fold className="work-row" summary={<><span>Worked</span><span>{message.text}</span></>}>
      {() => <pre>{message.detail}</pre>}
    </Fold>
  );
}

/** Run of tool calls: the newest one stays visible, the rest hide behind a +N counter. */
function ToolRun({ messages }: { messages: TaskMessage[] }) {
  if (messages.length === 1) return <ToolStep message={messages[0]!} />;
  const hidden = messages.length - 1;
  const summary = (
    <>
      <span>Worked</span>
      <span>{messages.at(-1)!.text}</span>
      <span className="work-count" aria-label={`${hidden} earlier tool ${hidden === 1 ? "call" : "calls"}`}>+{hidden}</span>
    </>
  );
  return (
    <Fold className="work-group" summary={summary}>
      {() => <div className="work-steps">{messages.map((message) => <ToolStep key={message.id} message={message} />)}</div>}
    </Fold>
  );
}

function TurnSegments({ segments }: { segments: TurnSegment[] }) {
  return segments.map((segment) => segment.kind === "tools"
    ? <ToolRun key={segment.id} messages={segment.messages} />
    : <div key={segment.id} className="message-text markdown-body work-note"><MarkdownMessage>{segment.message.text}</MarkdownMessage></div>);
}

/** Settled turn: every step, tool calls and interim text alike, folds behind one row. */
function SettledSteps({ steps }: { steps: TaskMessage[] }) {
  const summary = (
    <>
      <span>Worked</span>
      <span className="work-summary">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
    </>
  );
  return (
    <Fold className="work-group" summary={summary}>
      {() => <div className="work-steps"><TurnSegments segments={toSegments(steps)} /></div>}
    </Fold>
  );
}

export type ConversationTimelineProps = {
  currentTask?: Task;
  folder: string;
  status: "idle" | "running" | "stopped";
  compacting: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  empty?: { icon: LucideIcon; title: string; description: string };
};

export function ConversationTimeline({ currentTask, folder, status, compacting, scrollContainerRef, empty }: ConversationTimelineProps) {
  const messages = currentTask?.messages ?? [];
  const timelineRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const pinnedToBottom = useRef(true);
  const groups = useMemo(() => groupTimeline(messages, status === "running"), [messages, status]);
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
    let frame = 0;
    const onScroll = () => {
      pinnedToBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    };
    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(timeline);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [currentTask?.id, scrollContainerRef]);

  if (!currentTask?.messages.length) {
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
                  {group.steps.length > 0 && (group.live
                    ? <TurnSegments segments={toSegments(group.steps)} />
                    : <SettledSteps steps={group.steps} />)}
                  {group.final && <div className="message-text markdown-body"><MarkdownMessage>{group.final.text}</MarkdownMessage></div>}
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
      {viewing && <AttachmentViewer source={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
