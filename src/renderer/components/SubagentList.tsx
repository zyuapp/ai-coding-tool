import { memo, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuBot as Bot, LuCircleCheckBig as CheckCircle2, LuCircleDot as CircleDot, LuCirclePause as CirclePause, LuCircleStop as CircleStop, LuCircleX as XCircle } from "react-icons/lu";
import { OPEN_SUBAGENT_GROUPS, orderSubagents, subagentLine, subagentStatusLabel as statusLabel, type Subagent, type SubagentGroup, type SubagentGroups, type SubagentStatus } from "../../domain/run";
import { shortcutTip } from "./TooltipLayer";
import { Button, Segmented } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { SearchField } from "../ui/Field";
import { ListHeading, ListRow } from "../ui/List";
import { PanelHeader } from "../ui/PanelHeader";

const STATUS_FILTERS: SubagentStatus[] = ["working", "idle", "failed", "stopped", "completed"];

/** The tint a chosen status filter takes. */
const STATUS_TONES: Partial<Record<SubagentStatus, string>> = { working: "info", failed: "danger", stopped: "danger" };

/** The status filter's choice that filters nothing. */
const ALL = "all";

/** Above this many rows the list is windowed; a handful of rows are cheaper drawn whole. */
const VIRTUALIZE_ABOVE = 50;

const STATUS_ICONS = { working: CircleDot, idle: CirclePause, completed: CheckCircle2, failed: XCircle, stopped: CircleStop };

/** Each status has its own shape, so it reads without its colour. Unlabelled, it stands beside a label that names it. */
export function StatusIcon({ status, labelled = false }: { status: SubagentStatus; labelled?: boolean }) {
  const Icon = STATUS_ICONS[status];
  const className = `agent-status-icon ${status}${status === "working" ? " agent-working-icon" : ""}`;
  return labelled
    ? <Icon className={className} size={16} role="img" aria-label={statusLabel(status)} />
    : <Icon className={className} size={16} aria-hidden="true" />;
}

/** What the status strip and the search box between them leave on screen. */
export function matchSubagents(subagents: Subagent[], status: SubagentStatus | null, query: string) {
  const needle = query.trim().toLowerCase();
  return orderSubagents(subagents).filter((subagent) =>
    (!status || subagent.status === status)
    && (!needle || `${subagent.description} ${subagent.lastToolName ?? ""} ${subagent.summary ?? ""}`.toLowerCase().includes(needle)));
}

export function countByStatus(subagents: Subagent[]) {
  const counts: Record<SubagentStatus, number> = { working: 0, idle: 0, failed: 0, stopped: 0, completed: 0 };
  for (const subagent of subagents) counts[subagent.status] += 1;
  return counts;
}

export const SubagentRow = memo(function SubagentRow({ subagent, onSelect }: { subagent: Subagent; onSelect: (id: string) => void }) {
  const line = subagentLine(subagent);
  return (
    <ListRow
      className="agent-row"
      leading={<span className={`agent-orb ${subagent.status}`} aria-hidden="true"><Bot size={12} /></span>}
      title={subagent.description}
      detail={line}
      trailing={<StatusIcon status={subagent.status} labelled />}
      onClick={() => onSelect(subagent.id)}
    />
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
  return <ListHeading className="subagent-group" label={statusLabel(row.status)} count={row.count} open={row.open} onToggle={() => onSetGroup(row.status, !row.open)} />;
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
  const searchRef = useRef<HTMLInputElement>(null);
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
        <PanelHeader title="Subagents" />
        <EmptyState className="agents-panel-empty" icon={<Bot size={18} />} title="No subagents yet" />
      </section>
    );
  }

  return (
    <section className="agents-panel" aria-label="Agents">
      <PanelHeader title="Subagents" actions={<Chip variant="count">{subagents.length}</Chip>} />
      <div className="agents-filters">
        <Segmented
          className="agent-status-strip"
          variant="pills"
          label="Filter subagents by status"
          value={status ?? ALL}
          options={[
            { value: ALL, label: <>All <span>{subagents.length}</span></> },
            ...STATUS_FILTERS.filter((candidate) => counts[candidate] > 0).map((candidate) => ({
              value: candidate,
              label: <>{statusLabel(candidate)} <span>{counts[candidate]}</span></>,
              tone: STATUS_TONES[candidate],
            })),
          ]}
          onChange={(picked) => setStatus(picked === ALL || picked === status ? null : picked)}
        />
        <SearchField
          ref={searchRef}
          label="Search subagents"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }}
          onClear={() => { setQuery(""); searchRef.current?.focus(); }}
          clearTip={shortcutTip("Clear", "Escape")}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState
          size="inline"
          className="agents-panel-none"
          title="No subagents match."
          action={<Button variant="soft" onClick={() => { setStatus(null); setQuery(""); }}>Show all</Button>}
        />
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
