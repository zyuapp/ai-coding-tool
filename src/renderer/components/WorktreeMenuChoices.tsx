import { useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuPlus as Plus } from "react-icons/lu";
import type { AppCommand } from "../../contracts/commands";
import type { WorktreeMenuChoice, WorktreeMenuList, WorktreeMenuView } from "../../application/worktree-menu";
import { MenuEdgeAction, MenuItem, MenuNote, MenuSearch } from "../ui/Menu";

/** A two-line row's height, which the virtual list lays rows out by. */
const ROW_HEIGHT = 42;

function emptyNote(list: WorktreeMenuList, view: WorktreeMenuView): string {
  if (list === "destinations" && view.loading) return "Reading worktrees…";
  if (view.search[list].trim()) return "No matches";
  return list === "threads" ? "No other threads" : "No other worktrees";
}

export function WorktreeMenuChoices({ view, list, dispatch }: { view: WorktreeMenuView; list: WorktreeMenuList; dispatch: (command: AppCommand) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const creating = useRef<HTMLButtonElement>(null);
  const rows = list === "threads" ? view.threads : view.destinations;
  const searchable = list === "destinations" || view.count > 8;
  const virtual = rows.length > 40;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => ROW_HEIGHT, getItemKey: (index) => rows[index].id, overscan: 4, initialRect: { width: 280, height: 220 }, enabled: virtual });
  const query = view.search[list];
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [query]);

  function select(command: AppCommand) {
    dispatch({ type: "view.set-menu", menu: null });
    dispatch(command);
  }

  function choice(row: WorktreeMenuChoice, index: number) {
    return <MenuItem
      role="menuitem"
      className="worktree-menu-choice"
      data-choice-index={index}
      checked={row.current}
      disabled={row.disabled}
      aria-current={row.current ? "true" : undefined}
      data-tip={`${row.title} · ${row.detail}`}
      description={row.detail}
      onClick={() => select(row.command)}
    >
      {row.title}
    </MenuItem>;
  }

  /** The rows are virtual past a few dozen, so the keys walk them by index and scroll the next one in before focusing it. */
  return <div className="worktree-menu-panel" data-checkable onKeyDown={(event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.stopPropagation();
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" && event.key !== "ArrowDown") return;
    event.preventDefault();
    let index = target.dataset.choiceIndex === undefined ? -1 : Number(target.dataset.choiceIndex);
    const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = rows.length - 1;
    else if (index === -1 && direction === -1) { search.current?.focus(); return; }
    else if (target === search.current && creating.current) { creating.current.focus(); return; }
    else index += direction;
    if (index < 0) { (creating.current ?? search.current)?.focus(); return; }
    if (index >= rows.length) return;
    if (virtual) virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() => {
      const button = scroll.current?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`);
      button?.focus();
      if (!virtual) button?.scrollIntoView({ block: "nearest" });
    });
  }}>
    {searchable && <MenuSearch
      inputRef={search}
      label={list === "threads" ? "Search shared threads" : "Search worktrees or branches"}
      placeholder={list === "threads" ? "Search threads…" : "Search worktrees…"}
      value={query}
      onChange={(next) => dispatch({ type: "worktree.menu-search", list, query: next })}
      onSubmit={() => { const first = rows.find((row) => !row.disabled); if (first) select(first.command); }}
    />}
    {list === "destinations" && <MenuEdgeAction edge="top" ref={creating} className="worktree-menu-new" mark={<Plus size={14} />} disabled={!view.canMove} onClick={() => select({ type: "task.move-worktree", taskId: view.threadId, destination: { kind: "new" } })}>New worktree</MenuEdgeAction>}
    <div ref={scroll} className="worktree-menu-list" role="menu" aria-label={list === "threads" ? "Threads here" : "Move destinations"} style={{ height: Math.min(rows.length, 5) * ROW_HEIGHT }}>
      {virtual ? <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((item) => <div key={item.key} style={{ position: "absolute", top: item.start, height: item.size, width: "100%" }}>{choice(rows[item.index], item.index)}</div>)}</div> : rows.map((row, index) => <div key={row.id}>{choice(row, index)}</div>)}
    </div>
    {!rows.length && <MenuNote className="worktree-menu-note">{emptyNote(list, view)}</MenuNote>}
    {list === "destinations" && <>
      {view.error && <>
        <MenuNote tone="danger" role="alert">{view.error}</MenuNote>
        <MenuItem onClick={() => dispatch({ type: "worktree.menu-open", list: "destinations" })}>Retry</MenuItem>
      </>}
      <MenuNote className="worktree-menu-note">Existing file changes stay in the old checkout.</MenuNote>
    </>}
  </div>;
}
