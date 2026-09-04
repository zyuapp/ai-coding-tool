import { useEffect, useId, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuArrowLeft as ArrowLeft, LuArrowRight as ArrowRight, LuCheck as Check, LuChevronDown as ChevronDown, LuFolderSymlink as FolderSymlink, LuHouse as House, LuPlus as Plus, LuTrash2 as Trash } from "react-icons/lu";
import type { AppCommand } from "../../contracts/commands";
import type { CheckoutPanelView } from "../../application/checkout-panel";
import { worktreeHue } from "../../domain/worktree";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import "../checkout-panel.css";

type Dispatch = (command: AppCommand) => void;

/** Only the visible part of long lists mounts; arrow keys also reach rows outside that window. */
function CheckoutList<T extends { id: string; disabled?: boolean }>({ rows, label, children }: {
  rows: T[];
  label: string;
  children: (row: T) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = rows.length > 40;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 44,
    getItemKey: (index) => rows[index].id,
    overscan: 4,
    initialRect: { width: 260, height: 176 },
    enabled: virtual,
  });
  return <div className="checkout-scroll" ref={scroll} role="list" aria-label={label} onKeyDown={(event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row-index]");
    if (!row) return;
    let index = Number(row.dataset.rowIndex);
    if (event.key === "ArrowDown") index++;
    else if (event.key === "ArrowUp") index--;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = rows.length - 1;
    else return;
    event.preventDefault();
    index = Math.max(0, Math.min(rows.length - 1, index));
    const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
    while (rows[index]?.disabled) index += direction;
    if (index < 0 || index >= rows.length) return;
    if (virtual) virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`[data-row-index="${index}"] button`)?.focus());
  }}>
    {virtual ? <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((item) => <div key={item.key} role="listitem" aria-posinset={item.index + 1} aria-setsize={rows.length} data-row-index={item.index} style={{ position: "absolute", top: item.start, width: "100%", height: item.size }}>{children(rows[item.index])}</div>)}
    </div> : rows.map((row, index) => <div key={row.id} role="listitem" data-row-index={index}>{children(row)}</div>)}
    {!rows.length && <p className="checkout-empty">No matches.</p>}
  </div>;
}

function CheckoutMove({ view, dispatch }: { view: CheckoutPanelView; dispatch: Dispatch }) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { search.current?.focus(); }, []);
  return <div className="checkout-move" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "checkout.set-mode", mode: "threads" });
    }
  }}>
    <div className="checkout-move-heading">
      <button type="button" aria-label="Back to shared threads" onClick={() => dispatch({ type: "checkout.set-mode", mode: "threads" })}><ArrowLeft size={15} /></button>
      <strong>Move thread</strong>
    </div>
    <p className="checkout-origin">From {view.name}</p>
    <input ref={search} className="checkout-search" type="search" value={view.query} aria-label="Search worktrees, branches, or threads" placeholder="Search worktrees…" onInput={(event) => dispatch({ type: "checkout.search", query: event.currentTarget.value })} />
    <button type="button" className="checkout-new-destination" disabled={!view.canMove} aria-pressed={view.destination?.kind === "new"} onClick={() => dispatch({ type: "checkout.select-destination", destination: { kind: "new" } })}>
      <Plus size={14} /><span>New worktree…</span>{view.destination?.kind === "new" && <Check size={13} />}
    </button>
    <CheckoutList key={view.query} rows={view.destinations} label="Move destinations">{(destination) => <button
      type="button" className="checkout-list-row" disabled={destination.disabled || !view.canMove}
      aria-pressed={destination.selected} title={`${destination.name} · ${destination.branch}`}
      onClick={() => dispatch({ type: "checkout.select-destination", destination: destination.destination })}
    >
      {destination.destination.kind === "local" ? <House size={14} /> : <FolderSymlink size={14} />}
      <span className="checkout-row-copy"><span>{destination.name}</span><small>{destination.branch}</small></span>
      {destination.selected && <Check size={13} />}
    </button>}</CheckoutList>
    {view.loading && <p className="checkout-hint" role="status">Reading worktrees…</p>}
    <p className="checkout-hint">Existing file changes stay in the current checkout.</p>
    <button type="button" className="checkout-confirm" disabled={!view.canConfirm} onClick={() => {
      if (view.destination) dispatch({ type: "task.move-worktree", taskId: view.threadId, destination: view.destination });
    }}>{view.destination?.kind === "new" ? "Create worktree and move" : "Move thread"}</button>
  </div>;
}

export function CheckoutPanel({ view, dispatch }: { view: CheckoutPanelView; dispatch: Dispatch }) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const previousMode = useRef(view.mode);
  useEffect(() => {
    if (previousMode.current === "move" && view.mode === "threads") toggle.current?.focus({ preventScroll: true });
    previousMode.current = view.mode;
  }, [view.mode]);
  if (view.mode === "move" && !view.transition) return <div className="checkout-panel"><CheckoutMove view={view} dispatch={dispatch} />{view.error && <p className="checkout-error" role="alert">{view.error}</p>}</div>;
  return <div className="checkout-panel">
    <button ref={toggle} type="button" className="session-row session-row-action checkout-location" aria-expanded={view.open} aria-controls={id} title={view.root} disabled={Boolean(view.transition)} onClick={() => dispatch({ type: "checkout.set-open", open: !view.open })}>
      <span className={`session-row-icon${view.worktreeId ? ` worktree-mark hue-${worktreeHue(view.worktreeId)}` : ""}`}>{view.worktreeId || view.transition ? <FolderSymlink size={18} /> : <House size={18} />}</span>
      <span className="checkout-location-copy"><span className={view.transition ? "text-sweep" : undefined}>{view.transition ?? view.name}</span><small>{view.threadCount} {view.threadCount === 1 ? "thread" : "threads"}</small></span>
      <ChevronDown size={13} className={view.open ? "expanded" : ""} />
    </button>
    <div id={id} hidden={!view.open || Boolean(view.transition)}>
      <div className="checkout-toolbar">
        <input className="checkout-search" type="search" value={view.query} aria-label="Search shared threads" placeholder="Search threads…" onInput={(event) => dispatch({ type: "checkout.search", query: event.currentTarget.value })} />
        <button type="button" aria-label="New thread here" title="New thread here" onClick={() => dispatch({ type: "task.new", projectId: view.projectId, worktreeId: view.worktreeId })}><Plus size={14} /></button>
      </div>
      <CheckoutList key={view.query} rows={view.threads} label="Shared threads">{(thread) => <button type="button" className="checkout-list-row" aria-current={thread.current ? "true" : undefined} title={thread.title} onClick={() => dispatch({ type: "task.select", taskId: thread.id })}>
        <ThreadEngineIcon engine={thread.engine} size={14} />
        <span className="checkout-row-copy"><span>{thread.title}</span><small>{thread.status === "Working" && <span className="task-spinner" />}{thread.status === "Needs input" && <span className="task-attention approval" />}{thread.status}</small></span>
        {thread.current && <small className="checkout-current">Current</small>}
      </button>}</CheckoutList>
      <p className="checkout-result-count" aria-live="polite">{view.query ? `${view.threads.length} of ${view.threadCount} threads` : view.threadCount > 4 ? "Scroll for more threads" : ""}</p>
    </div>
    <button type="button" className="checkout-action" disabled={!view.canMove} onClick={() => dispatch({ type: "checkout.set-mode", mode: "move" })}><ArrowRight size={14} /><span>Move thread…</span></button>
    {view.deleteRoot && <button type="button" className="checkout-action checkout-delete" disabled={view.deleteDisabled} title={view.busyCount ? "Wait for all active runs in this worktree to finish" : undefined} onClick={() => dispatch({ type: "worktree.confirm-delete", root: view.deleteRoot })}>
      <Trash size={13} /><span>Delete worktree…</span>{view.busyCount > 0 && <small>{view.busyCount} active</small>}
    </button>}
    {view.error && <p className="checkout-error" role="alert">{view.error}</p>}
  </div>;
}
