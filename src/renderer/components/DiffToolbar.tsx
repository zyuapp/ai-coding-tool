import { useRef } from "react";
import { createPortal } from "react-dom";
import { LuArrowRight as ArrowRight, LuChevronDown as ChevronDown, LuColumns2 as Columns2, LuRefreshCw as RefreshCw, LuSpace as Space } from "react-icons/lu";
import { DIFF_MODE_MENU, type DiffState } from "../../application/workspace-diff";
import { DEFAULT_BRANCH_RANGE, type DiffMode, type DiffRange } from "../../domain/diff";
import { BranchMenu, useAnchoredStyle, useBranches } from "./BranchMenu";
import { useDismissibleLayer } from "../focus";
import { PickerOption, PickerPopover } from "./Picker";
import { SpinningIcon } from "./SpinningIcon";

const BASE_MENU = "diff:base";
const COMPARE_MENU = "diff:compare";
const HEAD_SIDE = { label: "HEAD", value: "HEAD" };
const WORKING_SIDE = { label: "Working tree", value: "" };
const MODES: Array<{ value: DiffMode; label: string; description: string }> = [
  { value: "uncommitted", label: "Uncommitted", description: "What changed since the last commit" },
  { value: "branch", label: "Branch", description: "What one branch adds over another" },
];

export type DiffPickerActions = {
  onSetMode: (mode: DiffMode) => void;
};

type MenuControl = {
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

type SidePickerProps = MenuControl & {
  id: string;
  label: string;
  /** The word the chip leads with, saying which end of the comparison it is. */
  role: string;
  value: string;
  extra: { label: string; value: string };
  /** The working tree wears its current branch's name, while the list still names it Working tree. */
  currentBranch?: string | null;
  workspaceId?: string;
  onPick: (value: string) => void;
};

function SidePicker({ id, label, role, value, extra, currentBranch, workspaceId, openMenu, onSetOpenMenu, onPick }: SidePickerProps) {
  const open = openMenu === id;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  const branches = useBranches(workspaceId, open);
  const shown = value === "" ? currentBranch ? `${currentBranch} · working` : "Working tree" : value === extra.value ? extra.label : value;
  const description = value === "" ? `Working tree${currentBranch ? ` on ${currentBranch}` : ""}` : shown;

  return (
    <div ref={row} className="diff-side" data-popover-menu>
      <button ref={trigger} className="diff-side-trigger" type="button" aria-label={`${label}: ${description}`} aria-haspopup="listbox" aria-expanded={open} data-tip={`${label}: ${description}`} disabled={!workspaceId} onClick={() => onSetOpenMenu(open ? null : id)}>
        <small>{role}</small><span>{shown}</span><ChevronDown size={12} />
      </button>
      {open && <BranchMenu menuRef={menu} anchor={row.current} branches={branches} includeRemotes extra={extra} title={label} selected={value} onPick={(picked) => { onSetOpenMenu(null); onPick(picked); }} />}
    </div>
  );
}

function ModePicker({ mode, disabled, openMenu, onSetOpenMenu, onSetMode }: MenuControl & { mode: DiffState["mode"]; disabled: boolean; onSetMode: (mode: DiffMode) => void }) {
  const open = openMenu === DIFF_MODE_MENU;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchored = useAnchoredStyle(open ? trigger.current : null, 230);
  useDismissibleLayer(open, [trigger, menu], () => onSetOpenMenu(null), trigger);
  const label = mode === "commit" ? "Commit" : MODES.find((item) => item.value === mode)!.label;
  return <>
    <button ref={trigger} className="diff-mode-trigger" type="button" aria-label={`Review mode: ${label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => onSetOpenMenu(open ? null : DIFF_MODE_MENU)}>{label}<ChevronDown size={12} /></button>
    {open && createPortal(
      <PickerPopover ref={menu} className="branch-menu anchored diff-mode-menu" role="menu" aria-label="Review mode" style={anchored ?? undefined}>
        {MODES.map((item) => <PickerOption key={item.value} role="menuitemradio" selected={mode === item.value} autoFocus={mode === item.value || (mode === "commit" && item.value === "uncommitted")} onClick={() => onSetMode(item.value)}>{item.label}<small>{item.description}</small></PickerOption>)}
      </PickerPopover>, document.body,
    )}
  </>;
}

export type DiffToolbarProps = MenuControl & DiffPickerActions & {
  diff: DiffState;
  split: boolean;
  roomForTwo: boolean;
  currentBranch?: string | null;
  workspaceId?: string;
  onSetRange: (range: DiffRange) => void;
  onToggleSplit: () => void;
  onToggleWhitespace: () => void;
  onRefresh: () => void;
};

/** Mode first; a branch comparison reads current work → target. */
export function DiffToolbar({ diff, split, roomForTwo, currentBranch, workspaceId, openMenu, onSetOpenMenu, onSetMode, onSetRange, onToggleSplit, onToggleWhitespace, onRefresh }: DiffToolbarProps) {
  const range = diff.range.kind === "branches" ? diff.range : diff.branchRange ?? DEFAULT_BRANCH_RANGE;
  return (
    <header className="diff-toolbar">
      <div className="diff-toolbar-main">
        <ModePicker mode={diff.mode} disabled={!workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onSetMode={onSetMode} />
        <div className="diff-toolbar-actions">
          <button
            type="button"
            aria-label="Two columns"
            aria-pressed={split}
            aria-disabled={!roomForTwo || undefined}
            className={split ? "on" : ""}
            data-tip={roomForTwo ? "Two columns" : "Two columns need a wider panel"}
            onClick={roomForTwo ? onToggleSplit : undefined}
          >
            <Columns2 size={16} />
          </button>
          <button type="button" aria-label="Hide spacing changes" aria-pressed={diff.ignoreWhitespace} className={diff.ignoreWhitespace ? "on" : ""} data-tip="Hide spacing changes" onClick={onToggleWhitespace}><Space size={16} /></button>
          <button type="button" aria-label="Read the comparison again" data-tip="Read again" onClick={onRefresh}><SpinningIcon icon={RefreshCw} spinning={diff.loading} size={16} /></button>
        </div>
      </div>
      {diff.range.kind === "commit" && <code className="diff-linked-commit" title={diff.range.commit}>{diff.range.commit.slice(0, 7)}</code>}
      {diff.mode === "branch" && <div className="diff-compare">
        <SidePicker id={COMPARE_MENU} label="Compare" role="From" value={range.compare ?? ""} extra={WORKING_SIDE} currentBranch={currentBranch} workspaceId={workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onPick={(compare) => onSetRange({ ...range, compare: compare || null })} />
        <ArrowRight className="diff-range-arrow" size={14} aria-hidden="true" />
        <SidePicker id={BASE_MENU} label="Target branch" role="Into" value={range.base} extra={HEAD_SIDE} workspaceId={workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onPick={(base) => onSetRange({ ...range, base })} />
      </div>}
    </header>
  );
}
