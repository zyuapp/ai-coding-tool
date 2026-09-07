import { useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuCheck as Check, LuPlus as Plus } from "react-icons/lu";
import type { AppCommand } from "../../contracts/commands";
import type { WorktreeMenuChoice, WorktreeMenuList, WorktreeMenuView } from "../../application/worktree-menu";

export function WorktreeMenuChoices({ view, list, dispatch }: { view: WorktreeMenuView; list: WorktreeMenuList; dispatch: (command: AppCommand) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const creating = useRef<HTMLButtonElement>(null);
  const rows = list === "threads" ? view.threads : view.destinations;
  const searchable = list === "destinations" || view.count > 8;
  const virtual = rows.length > 40;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 44, getItemKey: (index) => rows[index].id, overscan: 4, initialRect: { width: 280, height: 220 }, enabled: virtual });
  const query = view.search[list];
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [query]);

  function select(command: AppCommand) {
    dispatch({ type: "view.set-menu", menu: null });
    dispatch(command);
  }

  function choice(row: WorktreeMenuChoice, index: number) {
    return <button type="button" role="menuitem" className="worktree-menu-choice" data-choice-index={index} disabled={row.disabled} aria-current={row.current ? "true" : undefined} title={`${row.title} · ${row.detail}`} onClick={() => select(row.command)}>
      <span className="worktree-menu-copy"><span>{row.title}</span><small>{row.detail}</small></span>
      {row.current && <Check size={12} aria-hidden="true" />}
    </button>;
  }

  return <div className="worktree-menu-panel" onKeyDown={(event) => {
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
    while (rows[index]?.disabled) index += direction;
    if (index < 0) { (creating.current ?? search.current)?.focus(); return; }
    if (index >= rows.length) return;
    if (virtual) virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() => {
      const button = scroll.current?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`);
      button?.focus();
      if (!virtual) button?.scrollIntoView({ block: "nearest" });
    });
  }}>
    {searchable && <div className="worktree-menu-search"><input ref={search} type="search" value={view.search[list]} placeholder={list === "threads" ? "Search threads…" : "Search worktrees…"} aria-label={list === "threads" ? "Search shared threads" : "Search worktrees or branches"} onInput={(event) => dispatch({ type: "worktree.menu-search", list, query: event.currentTarget.value })} /></div>}
    {list === "destinations" && <><button ref={creating} type="button" role="menuitem" className="worktree-menu-new" disabled={!view.canMove} onClick={() => select({ type: "task.move-worktree", taskId: view.threadId, destination: { kind: "new" } })}><Plus size={13} />New worktree</button><div className="menu-separator" role="separator" /></>}
    <div ref={scroll} className="worktree-menu-list" role="menu" aria-label={list === "threads" ? "Threads here" : "Move destinations"} style={{ height: Math.min(rows.length, 5) * 44 }}>
      {virtual ? <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((item) => <div key={item.key} style={{ position: "absolute", top: item.start, height: item.size, width: "100%" }}>{choice(rows[item.index], item.index)}</div>)}</div> : rows.map((row, index) => <div key={row.id}>{choice(row, index)}</div>)}
    </div>
    {!rows.length && <p className="worktree-menu-note">{list === "destinations" && view.loading ? "Reading worktrees…" : "No matches."}</p>}
    {list === "destinations" && <>
      {view.error && <div className="worktree-menu-error"><p role="alert">{view.error}</p><button type="button" onClick={() => dispatch({ type: "worktree.menu-open", list: "destinations" })}>Retry</button></div>}
      <p className="worktree-menu-note">Existing file changes stay in the old checkout.</p>
    </>}
  </div>;
}
