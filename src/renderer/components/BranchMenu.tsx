import { Check, Plus, Search } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { BranchesResult } from "../../contracts/ipc";
import { moveListFocus } from "../focus";

/**
 * The branch a typed query would make: what the user typed, once it is a name no branch already has.
 * Whitespace is never a branch name, so a query that is only spaces asks for nothing.
 */
export function newBranchName(branches: string[], query: string) {
  const name = query.trim();
  return name && !branches.includes(name) ? name : null;
}

/** Which branches a typed query keeps, matched loosely so a fragment of a name is enough. */
export function matchBranches(branches: string[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? branches.filter((name) => name.toLowerCase().includes(needle)) : branches;
}

/** The checkout's local branches, read again whenever the checkout changes or reading is turned on. */
export function useBranches(workspaceId: string | undefined, enabled = true) {
  const [result, setResult] = useState<BranchesResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!workspaceId || !enabled) return;
    let cancelled = false;
    void window.desktop.branches(workspaceId)
      .then((branches) => { if (!cancelled) setResult(branches); })
      .catch((error) => { if (!cancelled) setResult({ status: "error", message: String(error) }); });
    return () => { cancelled = true; };
  }, [workspaceId, enabled]);

  return result;
}

/** The gap between the row a list hangs off and the list itself. */
const ANCHOR_GAP = 4;

/** The narrowest a list may be, for a trigger too small to hold a ref of any length. */
const MIN_MENU_WIDTH = 260;

/** Where a list sits beside a row it is not inside: on whichever side of it the viewport leaves more room. */
function anchoredStyle(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - ANCHOR_GAP * 2;
  const above = rect.top - ANCHOR_GAP * 2;
  const over = above > below;
  const width = Math.max(rect.width, MIN_MENU_WIDTH);
  /** A list wider than the row it hangs off would run past the window, so it slides back inside. */
  const left = Math.min(rect.left, window.innerWidth - width - ANCHOR_GAP);
  return {
    left: Math.max(ANCHOR_GAP, left),
    width,
    top: over ? undefined : rect.bottom + ANCHOR_GAP,
    bottom: over ? window.innerHeight - rect.top + ANCHOR_GAP : undefined,
    "--branch-menu-room": `${Math.max(above, below)}px`,
  } as CSSProperties;
}

/** Follows the anchor, since the panel it sits in scrolls out from under a list that does not move. */
function useAnchoredStyle(anchor: HTMLElement | null | undefined) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => setStyle(anchoredStyle(anchor));
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  return style;
}

export type BranchMenuProps = {
  branches: BranchesResult | null;
  /** The branch shown as chosen. A detached checkout has none, so nothing is ticked. */
  selected: string | null;
  /** `create` names a branch the repository does not have yet. */
  onPick: (branch: string, create: boolean) => void;
  /** The row to hang off, for a list whose surroundings would otherwise clip it. */
  anchor?: HTMLElement | null;
  menuRef?: RefObject<HTMLDivElement | null>;
  /** Remote branches too, for a list that compares against them rather than moving onto one. */
  includeRemotes?: boolean;
  /**
   * An option above the branches that is not one: the working tree, or the commit the checkout is on.
   * A list that offers one is choosing a side to compare, so it does not offer to make a branch.
   */
  extra?: { label: string; value: string };
  /** Names what is being chosen, for a list that is one of several a view opens. */
  title?: string;
};

/** The list a branch is chosen from: the branches, narrowed by search, and the name to make. */
export function BranchMenu({ branches, selected, onPick, anchor, menuRef, includeRemotes, extra, title }: BranchMenuProps) {
  const [query, setQuery] = useState("");
  const anchored = useAnchoredStyle(anchor);
  const available = branches?.status === "available" ? branches : null;
  const names = available ? [...available.branches, ...(includeRemotes ? available.remotes : [])] : [];
  const naming = extra ? null : newBranchName(names, query);
  const showExtra = extra && matchBranches([extra.label], query).length > 0;
  /** Remote names only mean something beside the local ones they are not, so only that list is grouped. */
  const groups = includeRemotes
    ? [
        { label: "Local", names: matchBranches(available?.branches ?? [], query) },
        { label: "Remote", names: matchBranches(available?.remotes ?? [], query) },
      ].filter((group) => group.names.length > 0)
    : [{ label: null, names: matchBranches(names, query) }];
  const matched = groups.reduce((count, group) => count + group.names.length, 0);

  const option = (name: string, label: string, className?: string) => (
    <button
      className={className}
      type="button"
      key={name}
      role="option"
      aria-selected={name === selected}
      onClick={() => onPick(name, false)}
    >
      <span className="branch-menu-mark">{name === selected && <Check size={14} />}</span>
      <span>{label}</span>
    </button>
  );

  const menu = (
    <div
      ref={menuRef}
      className={`branch-menu ${anchor ? "anchored" : ""} ${includeRemotes ? "grouped" : ""}`.trimEnd()}
      data-popover-menu
      style={anchored ?? undefined}
      onKeyDown={moveListFocus}
    >
      {title && <div className="branch-menu-title"><span>{title}</span><kbd>↑↓</kbd></div>}
      <label className="branch-menu-field">
        <Search size={13} aria-hidden="true" />
        <input
          className="branch-menu-search"
          aria-label="Search branches"
          placeholder="Search branches"
          autoFocus
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div role="listbox" aria-label="Branches">
        {naming && (
          <button type="button" role="option" aria-selected={false} onClick={() => onPick(naming, true)}>
            <span className="branch-menu-mark"><Plus size={14} /></span>
            <span>Create branch “{naming}”</span>
          </button>
        )}
        {showExtra && (
          <>
            {includeRemotes && <p className="branch-menu-group">Not a branch</p>}
            {option(extra.value, extra.label, "branch-menu-extra")}
          </>
        )}
        {matched === 0 && !naming && !showExtra && <p className="branch-menu-empty">{branches ? "No branch matches" : "Reading branches…"}</p>}
        {groups.map((group) => (
          <Fragment key={group.label ?? "all"}>
            {group.label && <p className="branch-menu-group">{group.label}</p>}
            {group.names.map((name) => option(name, name))}
          </Fragment>
        ))}
      </div>
    </div>
  );

  return anchor ? createPortal(menu, document.body) : menu;
}
