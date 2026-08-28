import { memo, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuBot as Bot, LuCircleCheckBig as CheckCircle2, LuCircleDot as CircleDot, LuCircleX as XCircle, LuSearch as Search } from "react-icons/lu";
import { OPEN_SUBAGENT_GROUPS, type Subagent, type SubagentGroup, type SubagentGroups, type SubagentStatus } from "../../domain/run";

/** Failures first, then the work still going: a session with a thousand subagents is read from the top. */
const STATUS_RANK: Record<SubagentStatus, number> = { failed: 0, working: 1, idle: 2, stopped: 3, completed: 4 };

const STATUS_FILTERS: SubagentStatus[] = ["working", "idle", "failed", "stopped", "completed"];

/** Above this many rows the list is windowed; a handful of rows are cheaper drawn whole. */
const VIRTUALIZE_ABOVE = 50;

export function statusLabel(status: SubagentStatus) {
  return { working: "Working", idle: "Idle", completed: "Completed", failed: "Failed", stopped: "Stopped" }[status];
}

export function StatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "working") return <CircleDot className="agent-working-icon" size={16} />;
  if (status === "idle") return <CircleDot size={16} />;
  if (status === "completed") return <CheckCircle2 size={16} />;
  return <XCircle size={16} />;
}

/** One steady line per subagent: what it is doing now, or what it came back with. */
export function subagentLine(subagent: Subagent) {
  if (subagent.status === "working") return subagent.lastToolName ? `Using ${subagent.lastToolName}` : "Working";
  return subagent.summary?.split("\n")[0] ?? statusLabel(subagent.status);
}

export function orderSubagents(subagents: Subagent[]) {
  return [...subagents].sort((left, right) => STATUS_RANK[left.status] - STATUS_RANK[right.status]);
}

/** What the status strip and the search box between them leave on screen. */
export function matchSubagents(subagents: Subagent[], status: SubagentStatus | null, query: string) {
  const needle = query.trim().toLowerCase();
  return orderSubagents(subagents).filter((subagent) =>
    (!status || subagent.status === status)
    && (!needle || `${subagent.description} ${subagent.lastToolName ?? ""}`.toLowerCase().includes(needle)));
}

export function countByStatus(subagents: Subagent[]) {
  const counts: Record<SubagentStatus, number> = { working: 0, idle: 0, failed: 0, stopped: 0, completed: 0 };
  for (const subagent of subagents) counts[subagent.status] += 1;
  return counts;
}

export const SubagentRow = memo(function SubagentRow({ subagent, onSelect }: { subagent: Subagent; onSelect: (id: string) => void }) {
  return (
    <button className="agent-row" onClick={() => onSelect(subagent.id)} aria-label={`Open ${subagent.description} details`}>
      <span className={`agent-orb ${subagent.status}`}><Bot size={12} /></span>
      <span><strong>{subagent.description}</strong><small>{subagentLine(subagent)}</small></span>
      <StatusIcon status={subagent.status} />
    </button>
  );
});

type Row = { kind: "header"; status: SubagentStatus; count: number; open: boolean } | { kind: "agent"; subagent: Subagent };

/** A folded group keeps its heading and drops its rows, so what is folded stays out of the window entirely. */
function rowsFor(subagents: Subagent[], grouped: boolean, groups: SubagentGroups): Row[] {
  if (!grouped) return subagents.map((subagent) => ({ kind: "agent", subagent }));
  const counts = countByStatus(subagents);
  const rows: Row[] = [];
  let bucket: SubagentStatus | null = null;
  for (const subagent of subagents) {
    if (subagent.status !== bucket) {
      bucket = subagent.status;
      rows.push({ kind: "header", status: bucket, count: counts[bucket], open: groups[bucket] });
    }
    if (groups[subagent.status]) rows.push({ kind: "agent", subagent });
  }
  return rows;
}

function renderRow(row: Row, onSelect: (id: string) => void, onSetGroup: (group: SubagentGroup, open: boolean) => void) {
  if (row.kind === "agent") return <SubagentRow subagent={row.subagent} onSelect={onSelect} />;
  return (
    <button className="subagent-group" type="button" aria-expanded={row.open} onClick={() => onSetGroup(row.status, !row.open)}>
      <span>{statusLabel(row.status)}<span className="section-chevron" aria-hidden="true" /></span>
      <span>{row.count}</span>
    </button>
  );
}

export function AgentsPanel({ subagents, groups, finding = false, onSelect, onSetGroup }: {
  subagents: Subagent[];
  /** Which status headings are unfolded. */
  groups: SubagentGroups;
  /** Whether a search is reading this panel: it reads what was drawn, so while one is open every row is. */
  finding?: boolean;
  onSelect: (id: string) => void;
  onSetGroup: (group: SubagentGroup, open: boolean) => void;
}) {
  const [status, setStatus] = useState<SubagentStatus | null>(null);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => countByStatus(subagents), [subagents]);
  /** A search reads what the panel drew, so while one is open every group unfolds. */
  const shown = finding ? OPEN_SUBAGENT_GROUPS : groups;
  const rows = useMemo(() => rowsFor(matchSubagents(subagents, status, query), !status, shown), [subagents, status, query, shown]);
  const virtual = rows.length > VIRTUALIZE_ABOVE && !finding;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "header" ? 30 : 42,
    getItemKey: (index) => {
      const row = rows[index];
      return row?.kind === "agent" ? row.subagent.id : `header:${row?.status ?? index}`;
    },
    overscan: 8,
    initialRect: { width: 360, height: 720 },
  });

  if (!subagents.length) {
    return (
      <section className="agents-panel" aria-label="Agents">
        <header className="agents-panel-heading">
          <div><h2>Subagents</h2><p>Work delegated from this task</p></div>
        </header>
        <div className="agents-panel-empty">
          <span className="agent-orb"><Bot size={17} /></span>
          <h2>No subagents yet</h2>
          <p>Subagents created by the main task will appear here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="agents-panel" aria-label="Agents">
      <header className="agents-panel-heading">
        <div><h2>Subagents</h2><p>Work delegated from this task</p></div>
        <span>{subagents.length}</span>
      </header>
      <div className="agents-filters">
        <div className="agent-status-strip" role="group" aria-label="Filter subagents by status">
          <button type="button" aria-pressed={!status} onClick={() => setStatus(null)}>All <span>{subagents.length}</span></button>
          {STATUS_FILTERS.filter((candidate) => counts[candidate] > 0).map((candidate) => (
            <button key={candidate} className={candidate} type="button" aria-pressed={status === candidate} onClick={() => setStatus(status === candidate ? null : candidate)}>
              {statusLabel(candidate)} <span>{counts[candidate]}</span>
            </button>
          ))}
        </div>
        <label className="agent-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search subagents" aria-label="Search subagents" />
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="session-empty agents-panel-none">No subagents match.</p>
      ) : (
        <div className="subagent-list agents-panel-list" ref={scrollRef} aria-live="polite">
          {virtual ? (
            <div className="subagent-rows" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => (
                <div
                  className="subagent-row"
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {renderRow(rows[item.index]!, onSelect, onSetGroup)}
                </div>
              ))}
            </div>
          ) : (
            rows.map((row, index) => (
              <div className="subagent-row static" key={row.kind === "agent" ? row.subagent.id : `header:${row.status}${index}`}>
                {renderRow(row, onSelect, onSetGroup)}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
