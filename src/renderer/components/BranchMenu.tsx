import { Check, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { BranchesResult } from "../../contracts/ipc";

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

/** Where a list sits beside a row it is not inside: on whichever side of it the viewport leaves more room. */
function anchoredStyle(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - ANCHOR_GAP * 2;
  const above = rect.top - ANCHOR_GAP * 2;
  const over = above > below;
  return {
    left: rect.left,
    width: rect.width,
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
};

/** The list a branch is chosen from: every local branch, narrowed by search, and the name to make. */
export function BranchMenu({ branches, selected, onPick, anchor }: BranchMenuProps) {
  const [query, setQuery] = useState("");
  const anchored = useAnchoredStyle(anchor);
  const names = branches?.status === "available" ? branches.branches : [];
  const matches = matchBranches(names, query);
  const naming = newBranchName(names, query);

  const menu = (
    <div className={`branch-menu ${anchor ? "anchored" : ""}`.trimEnd()} data-popover-menu style={anchored ?? undefined}>
      <input
        className="branch-menu-search"
        aria-label="Search branches"
        placeholder="Search branches"
        autoFocus
        value={query}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <div role="listbox" aria-label="Branches">
        {naming && (
          <button role="option" aria-selected={false} onClick={() => onPick(naming, true)}>
            <span>Create branch “{naming}”</span>
            <Plus size={14} />
          </button>
        )}
        {matches.length === 0 && !naming && <p className="branch-menu-empty">{branches ? "No branch matches" : "Reading branches…"}</p>}
        {matches.map((name) => (
          <button key={name} role="option" aria-selected={name === selected} onClick={() => onPick(name, false)}>
            <span>{name}</span>
            {name === selected && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  );

  return anchor ? createPortal(menu, document.body) : menu;
}
