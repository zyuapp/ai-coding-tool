import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Wrench, X } from "lucide-react";
import type { Subagent, SubagentActivity } from "../../domain/run";
import { statusLabel, StatusIcon } from "./SubagentList";

/** How much of a log opens with the subagent. The rest is read backwards, a window at a time. */
const TAIL = 60;

/** Above this many rows the log is windowed; a short log is cheaper drawn whole. */
const VIRTUALIZE_ABOVE = 50;

function activityItem(item: SubagentActivity) {
  return item.kind === "tool" ? (
    <details className="agent-tool">
      <summary><Wrench size={14} />{item.title ?? "Tool"}</summary>
      <pre>{item.text}</pre>
    </details>
  ) : (
    <p className="agent-text">{item.text}</p>
  );
}

export function SubagentInspector({ subagent, onClose }: { subagent: Subagent; onClose: () => void }) {
  const [limit, setLimit] = useState(TAIL);
  const scrollRef = useRef<HTMLDivElement>(null);
  const start = Math.max(0, subagent.activity.length - limit);
  const shown = subagent.activity.length - start;
  const virtual = shown > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: shown,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    getItemKey: (index) => subagent.activity[start + index]?.id ?? index,
    overscan: 8,
    initialRect: { width: 360, height: 720 },
  });

  return (
    <aside className="subagent-inspector" aria-label={`${subagent.description} details`}>
      <header className="inspector-header">
        <span>Subagent</span>
        <button type="button" aria-label="Close subagent details" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="inspector-scroll" ref={scrollRef}>
        <div className="agent-detail-heading">
          <span className={`agent-orb ${subagent.status}`}><Bot size={17} /></span>
          <div>
            <h2>{subagent.description}</h2>
            <span className={`agent-status ${subagent.status}`}><StatusIcon status={subagent.status} />{statusLabel(subagent.status)}</span>
          </div>
        </div>
        {(subagent.summary || subagent.lastToolName || subagent.totalTokens !== undefined) && (
          <div className="agent-summary">
            {subagent.summary && <p>{subagent.summary}</p>}
            <div>
              {subagent.lastToolName && <span>Last tool: {subagent.lastToolName}</span>}
              {subagent.totalTokens !== undefined && <span>{subagent.totalTokens.toLocaleString()} tokens</span>}
            </div>
          </div>
        )}
        <div className="agent-activity" aria-live="polite">
          {start > 0 && (
            <button className="agent-activity-earlier" type="button" onClick={() => setLimit(limit + TAIL)}>
              Load earlier ({start})
            </button>
          )}
          {shown === 0 ? (
            <p className="session-empty">Waiting for activity…</p>
          ) : (
            <div className="agent-activity-items" style={virtual ? { height: virtualizer.getTotalSize() } : undefined}>
              {virtual
                ? virtualizer.getVirtualItems().map((row) => (
                  <div
                    className="agent-activity-row"
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    {activityItem(subagent.activity[start + row.index]!)}
                  </div>
                ))
                : Array.from({ length: shown }, (_, index) => {
                  const item = subagent.activity[start + index]!;
                  return <div className="agent-activity-row static" key={item.id}>{activityItem(item)}</div>;
                })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
