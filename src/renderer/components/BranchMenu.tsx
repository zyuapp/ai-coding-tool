import { LuPlus as Plus } from "react-icons/lu";
import { Fragment, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { BranchesResult } from "../../contracts/ipc";
import { MenuGroup, MenuHeading, MenuItem, MenuNote, MenuOptions, MenuSearch, MenuSeparator, MenuSurface, useListKeys, useMenuAnchor } from "../ui/Menu";

/** The narrowest a list may be, for a trigger too small to hold a ref of any length. */
const MIN_MENU_WIDTH = 260;

/**
 * The branch a typed query would make: what the user typed, once it is a name no branch already has.
 * Whitespace is never a branch name, so a query that is only spaces asks for nothing.
 */
export function newBranchName(branches: string[], query: string) {
  const name = query.trim();
  return name && !branches.includes(name) ? name : null;
}

/** Which branches a typed query keeps, matched loosely so a fragment of a name is enough, with the exact name first. */
export function matchBranches(branches: string[], query: string) {
  const typed = query.trim();
  const needle = typed.toLowerCase();
  if (!needle) return branches;
  const matched = branches.filter((name) => name.toLowerCase().includes(needle));
  const exact = matched.indexOf(typed);
  return exact > 0 ? [typed, ...matched.slice(0, exact), ...matched.slice(exact + 1)] : matched;
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
  const fallback = useRef<HTMLDivElement>(null);
  const surface = menuRef ?? fallback;
  const anchored = useMenuAnchor(anchor, surface, { minWidth: MIN_MENU_WIDTH });
  const listKeys = useListKeys();
  const available = branches?.status === "available" ? branches : null;
  const names = available ? [...available.branches, ...(includeRemotes ? available.remotes : [])] : [];
  const naming = extra || !available ? null : newBranchName(names, query);
  const showExtra = extra && matchBranches([extra.label], query).length > 0;
  /** Remote names only mean something beside the local ones they are not, so only that list is grouped. */
  const groups = includeRemotes
    ? [
        { label: "Local", names: matchBranches(available?.branches ?? [], query) },
        { label: "Remote", names: matchBranches(available?.remotes ?? [], query) },
      ].filter((group) => group.names.length > 0)
    : [{ label: null, names: matchBranches(names, query) }];
  const matched = groups.reduce((count, group) => count + group.names.length, 0);
  /** Enter takes the top row: a typed name no branch has is made, and otherwise the best match is checked out. */
  const top = showExtra ? extra.value : groups[0]?.names[0];
  function submit() {
    if (naming) onPick(naming, true);
    else if (top !== undefined) onPick(top, false);
  }
  let empty = "Reading branches…";
  if (branches?.status === "error") empty = branches.message;
  else if (branches) empty = "No branch matches";

  const option = (name: string, label: string) => (
    <MenuItem
      key={name}
      role="option"
      checked={name === selected}
      data-default={!naming && name === top ? "" : undefined}
      onClick={() => onPick(name, false)}
    >
      {label}
    </MenuItem>
  );

  const menu = (
    <MenuSurface
      ref={surface}
      checkable
      scroll
      anchored={Boolean(anchor)}
      className="picker-popover branch-menu"
      style={anchor ? anchored : undefined}
      onKeyDown={listKeys}
    >
      {title && <MenuHeading>{title}</MenuHeading>}
      <MenuSearch label="Search branches" value={query} onChange={setQuery} onSubmit={submit} autoFocus />
      <MenuOptions aria-label="Branches">
        {naming && (
          <MenuItem role="option" checked={false} mark={<Plus size={14} />} data-default="" onClick={() => onPick(naming, true)}>
            Create branch “{naming}”
          </MenuItem>
        )}
        {showExtra && (includeRemotes
          ? <MenuGroup label="Not a branch">{option(extra.value, extra.label)}</MenuGroup>
          : <>{option(extra.value, extra.label)}{matched > 0 && <MenuSeparator />}</>)}
        {matched === 0 && !naming && !showExtra && <MenuNote className="branch-menu-empty" tone={branches?.status === "error" ? "danger" : "quiet"} role={branches?.status === "error" ? "alert" : "status"}>{empty}</MenuNote>}
        {groups.map((group) => group.label
          ? <MenuGroup key={group.label} label={group.label}>{group.names.map((name) => option(name, name))}</MenuGroup>
          : <Fragment key="all">{group.names.map((name) => option(name, name))}</Fragment>)}
      </MenuOptions>
    </MenuSurface>
  );

  return anchor ? createPortal(menu, document.body) : menu;
}
