import { Check, Plus } from "lucide-react";
import { useEffect, useState } from "react";
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

export type BranchMenuProps = {
  branches: BranchesResult | null;
  /** The branch shown as chosen. A detached checkout has none, so nothing is ticked. */
  selected: string | null;
  /** `create` names a branch the repository does not have yet. */
  onPick: (branch: string, create: boolean) => void;
};

/** The list a branch is chosen from: every local branch, narrowed by search, and the name to make. */
export function BranchMenu({ branches, selected, onPick }: BranchMenuProps) {
  const [query, setQuery] = useState("");
  const names = branches?.status === "available" ? branches.branches : [];
  const matches = matchBranches(names, query);
  const naming = newBranchName(names, query);

  return (
    <div className="branch-menu" data-popover-menu>
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
}
