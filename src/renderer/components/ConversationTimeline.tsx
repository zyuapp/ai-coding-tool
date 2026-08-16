import { useVirtualizer } from "@tanstack/react-virtual";
import { ListCollapse, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import type { Task } from "../../domain/task";
import { MarkdownMessage } from "./MarkdownMessage";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
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
  const pinnedToBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => messages[index]?.kind === "user" ? 88 : messages[index]?.kind === "tool" ? 64 : 140,
    getItemKey: (index) => messages[index]?.id ?? index,
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
          const message = messages[item.index]!;
          return (
            <div
              className={`timeline-row ${message.kind}`}
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <article className={`message ${message.kind}`}>
                {message.kind === "tool" ? (
                  <details className="work-row">
                    <summary><span>Worked</span><span>{message.text}</span></summary>
                    <pre>{message.detail}</pre>
                  </details>
                ) : message.kind === "assistant" ? (
                  <div className="message-text markdown-body"><MarkdownMessage>{message.text}</MarkdownMessage></div>
                ) : (
                  <div className="message-text">{message.text}</div>
                )}
              </article>
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
    </div>
  );
}
