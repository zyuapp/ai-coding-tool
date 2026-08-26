import { useRef } from "react";
import { ChevronDown, Columns2, Pilcrow, RefreshCw, Rows3 } from "lucide-react";
import { UNCOMMITTED, type DiffRange } from "../../domain/diff";
import { BranchMenu, useBranches } from "./BranchMenu";
import { useDismissibleLayer } from "../focus";

const BASE_MENU = "diff:base";
const COMPARE_MENU = "diff:compare";

/**
 * The two sides that are not branches: the commit the checkout is on, and what is on disk right now.
 * Both are short, because the dock is narrow and a truncated side reads as a truncated branch name.
 */
const HEAD_SIDE = { label: "HEAD", value: "HEAD" };
const WORKING_SIDE = { label: "Working tree", value: "" };

type SidePickerProps = {
  id: string;
  label: string;
  /** The side as it is being compared: a branch name, or the extra option's own value. */
  value: string;
  extra: { label: string; value: string };
  /** Names the list this side opens, since the two sides open one each. */
  title: string;
  workspaceId?: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onPick: (value: string) => void;
};

/** One side of the comparison: the branches the checkout knows, plus the one thing that is not a branch. */
function SidePicker({ id, label, value, extra, title, workspaceId, openMenu, onSetOpenMenu, onPick }: SidePickerProps) {
  const open = openMenu === id;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  const branches = useBranches(workspaceId, open);
  const shown = value === extra.value ? extra.label : value;

  return (
    <div ref={row} className="diff-side" data-popover-menu>
      <button
        ref={trigger}
        className="diff-side-trigger"
        type="button"
        aria-label={`${label}: ${shown}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!workspaceId}
        onClick={() => onSetOpenMenu(open ? null : id)}
      >
        <span className="diff-side-label" aria-hidden="true">{label}</span>
        <code title={shown}>{shown}</code>
        <ChevronDown size={13} />
      </button>
      {open && (
        <BranchMenu
          menuRef={menu}
          anchor={row.current}
          branches={branches}
          includeRemotes
          extra={extra}
          title={title}
          selected={value}
          onPick={(picked) => {
            onSetOpenMenu(null);
            onPick(picked);
          }}
        />
      )}
    </div>
  );
}

export type DiffToolbarProps = {
  range: DiffRange;
  loading: boolean;
  split: boolean;
  roomForTwo: boolean;
  ignoreWhitespace: boolean;
  workspaceId?: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onSetRange: (range: DiffRange) => void;
  onToggleSplit: () => void;
  onToggleWhitespace: () => void;
  onRefresh: () => void;
};

/** What is being compared, in how many columns, and the way to read it again. */
export function DiffToolbar({ range, loading, split, roomForTwo, ignoreWhitespace, workspaceId, openMenu, onSetOpenMenu, onSetRange, onToggleSplit, onToggleWhitespace, onRefresh }: DiffToolbarProps) {
  const base = range.kind === "uncommitted" ? HEAD_SIDE.value : range.base;
  const compare = range.kind === "uncommitted" ? WORKING_SIDE.value : range.compare ?? WORKING_SIDE.value;
  const rangeFrom = (nextBase: string, nextCompare: string): DiffRange =>
    nextBase === HEAD_SIDE.value && nextCompare === WORKING_SIDE.value
      ? UNCOMMITTED
      : { kind: "branches", base: nextBase, compare: nextCompare === WORKING_SIDE.value ? null : nextCompare };

  return (
    <header className="diff-toolbar">
      <div className="diff-compare">
        <SidePicker
          id={BASE_MENU}
          label="Base"
          title="Compare from"
          value={base}
          extra={HEAD_SIDE}
          {...(workspaceId ? { workspaceId } : {})}
          openMenu={openMenu}
          onSetOpenMenu={onSetOpenMenu}
          onPick={(picked) => onSetRange(rangeFrom(picked, compare))}
        />
        <span className="diff-range" aria-hidden="true">...</span>
        <SidePicker
          id={COMPARE_MENU}
          label="Compare"
          title="Compare against"
          value={compare}
          extra={WORKING_SIDE}
          {...(workspaceId ? { workspaceId } : {})}
          openMenu={openMenu}
          onSetOpenMenu={onSetOpenMenu}
          onPick={(picked) => onSetRange(rangeFrom(base, picked))}
        />
      </div>
      <div className="diff-toolbar-actions">
        <button
          type="button"
          aria-label={split ? "Show one column" : "Show two columns"}
          aria-pressed={split}
          className={split ? "on" : ""}
          disabled={!roomForTwo}
          title={roomForTwo
            ? (split ? "Read the changes in one column" : "Put the old and new sides beside each other")
            : "Widen the panel to compare in two columns"}
          onClick={onToggleSplit}
        >
          {split ? <Rows3 size={15} /> : <Columns2 size={15} />}
        </button>
        <button
          type="button"
          aria-label={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          aria-pressed={ignoreWhitespace}
          className={ignoreWhitespace ? "on" : ""}
          title={ignoreWhitespace ? "Show lines where only the spacing changed" : "Hide lines where only the spacing changed"}
          onClick={onToggleWhitespace}
        >
          <Pilcrow size={15} />
        </button>
        <button type="button" aria-label="Read the comparison again" title="Read the comparison again" onClick={onRefresh}>
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
        </button>
      </div>
    </header>
  );
}
