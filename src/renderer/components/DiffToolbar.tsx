import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuArrowRight as ArrowRight, LuCheck as Check, LuChevronDown as ChevronDown, LuColumns2 as Columns2, LuCopy as Copy, LuGitCommitHorizontal as Commit, LuKeyboard as Keyboard, LuPilcrow as Pilcrow, LuRefreshCw as RefreshCw } from "react-icons/lu";
import { DIFF_MODE_MENU, type DiffState } from "../../application/workspace-diff";
import { DEFAULT_BRANCH_RANGE, type DiffMode, type DiffRange } from "../../domain/diff";
import { BranchMenu, useAnchoredStyle, useBranches } from "./BranchMenu";
import { useDismissibleLayer } from "../focus";
import { PickerOption, PickerPopover } from "./Picker";
import { SpinningIcon } from "./SpinningIcon";
import { copyText } from "../clipboard";
import { MAC } from "../platform";
import { displayShortcut } from "../../domain/shortcuts";
import { shortcutTip } from "./TooltipLayer";

const BASE_MENU = "diff:base";
export const KEYS_MENU = "diff:keys";
const COMPARE_MENU = "diff:compare";
const HEAD_SIDE = { label: "HEAD", value: "HEAD" };
const WORKING_SIDE = { label: "Working tree", value: "" };
const NO_PROJECT = "Open a project to review changes";
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

/** A long name split so its end, which tells branches apart, stays in view when the chip narrows. */
function splitName(name: string, suffix = "") {
  const keep = 10;
  if (name.length <= keep + 4) return { head: name + suffix, tail: "" };
  return { head: name.slice(0, -keep), tail: name.slice(-keep) + suffix };
}

function SidePicker({ id, label, role, value, extra, currentBranch, workspaceId, openMenu, onSetOpenMenu, onPick }: SidePickerProps) {
  const open = openMenu === id;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  const branches = useBranches(workspaceId, open);
  const shown = value === "" ? currentBranch ? splitName(currentBranch, " · working") : splitName("Working tree") : splitName(value === extra.value ? extra.label : value);
  const description = value === "" ? `Working tree${currentBranch ? ` on ${currentBranch}` : ""}` : shown.head + shown.tail;

  return (
    <div ref={row} className="diff-side" data-popover-menu>
      <button
        ref={trigger}
        className="diff-side-trigger"
        type="button"
        aria-label={`${label}: ${description}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={!workspaceId || undefined}
        data-tip={workspaceId ? `${label}: ${description}` : NO_PROJECT}
        onClick={workspaceId ? () => onSetOpenMenu(open ? null : id) : undefined}
      >
        <small>{role}</small><span><span>{shown.head}</span>{shown.tail && <span>{shown.tail}</span>}</span><ChevronDown size={12} />
      </button>
      {open && <BranchMenu menuRef={menu} anchor={row.current} branches={branches} includeRemotes extra={extra} title={label} selected={value} onPick={(picked) => { onSetOpenMenu(null); onPick(picked); }} />}
    </div>
  );
}

function ModePicker({ mode, commit, disabled, openMenu, onSetOpenMenu, onSetMode }: MenuControl & { mode: DiffState["mode"]; commit: string | null; disabled: boolean; onSetMode: (mode: DiffMode) => void }) {
  const open = openMenu === DIFF_MODE_MENU;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchored = useAnchoredStyle(open ? trigger.current : null, 230);
  useDismissibleLayer(open, [trigger, menu], () => onSetOpenMenu(null), trigger);
  const label = mode === "commit" ? "Commit" : MODES.find((item) => item.value === mode)!.label;
  return <>
    <button
      ref={trigger}
      className="diff-mode-trigger"
      type="button"
      aria-label={`Review mode: ${label}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      data-tip={disabled ? NO_PROJECT : undefined}
      onClick={disabled ? undefined : () => onSetOpenMenu(open ? null : DIFF_MODE_MENU)}
    ><small>Review</small><span>{label}</span><ChevronDown size={12} /></button>
    {open && createPortal(
      <PickerPopover ref={menu} className="branch-menu anchored diff-mode-menu" role="menu" aria-label="Review mode" style={anchored ?? undefined}>
        {mode === "commit" && commit && <PickerOption role="menuitemradio" selected autoFocus onClick={() => onSetOpenMenu(null)}>Commit<small>{`What ${commit.slice(0, 7)} changed`}</small></PickerOption>}
        {MODES.map((item) => <PickerOption key={item.value} role="menuitemradio" selected={mode === item.value} autoFocus={mode === item.value} onClick={() => onSetMode(item.value)}>{item.label}<small>{item.description}</small></PickerOption>)}
      </PickerPopover>, document.body,
    )}
  </>;
}

/** How a review is read and commented on, from the pointer and from the keys. */
const SHIFT = MAC ? "⇧" : "Shift";
const REVIEW_GESTURES: ReadonlyArray<readonly [gesture: string, does: string]> = [
  ["Click a line number", "Comment on that line"],
  [`Drag or ${SHIFT}-click`, "Comment on more lines"],
];
const REVIEW_KEYS: ReadonlyArray<readonly [keys: string, does: string]> = [
  ["N", "Next unviewed file"],
  ["O", "Open the file in your editor"],
  ["↑↓", "Walk files and line numbers"],
  [MAC ? "⇧↑↓" : "Shift+↑↓", "Pick more lines"],
  [displayShortcut("Enter", MAC), "Write the note"],
  ["?", "Show these keys"],
];

function ReviewKeys({ openMenu, onSetOpenMenu }: MenuControl) {
  const open = openMenu === KEYS_MENU;
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const id = useId();
  const anchored = useAnchoredStyle(open ? trigger.current : null, 280);
  useDismissibleLayer(open, [trigger, card], () => onSetOpenMenu(null), trigger);
  return <>
    <button
      ref={trigger}
      type="button"
      aria-label="Review keys"
      aria-keyshortcuts="?"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      data-tip={open ? undefined : shortcutTip("Review keys", "?")}
      onClick={() => onSetOpenMenu(open ? null : KEYS_MENU)}
    >
      <Keyboard size={16} />
    </button>
    {open && createPortal(
      <div ref={card} id={id} className="picker-popover branch-menu anchored diff-keys" role="dialog" aria-label="Review keys" data-popover-menu style={anchored ?? undefined}>
        <dl>
          {REVIEW_GESTURES.map(([gesture, does]) => <div key={gesture}><dt>{gesture}</dt><dd>{does}</dd></div>)}
          {REVIEW_KEYS.map(([keys, does]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{does}</dd></div>)}
        </dl>
      </div>, document.body,
    )}
  </>;
}

/** The reviewed commit's short name; a click copies the full hash and says so in place. */
function LinkedCommit({ commit }: { commit: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const tip = copied === true ? "Copied" : copied === false ? "Copy failed" : `Copy ${commit}`;
  return (
    <button
      className={`diff-linked-commit ${copied === true ? "copied" : copied === false ? "failed" : ""}`.trimEnd()}
      type="button"
      aria-label={copied === null ? `Copy commit ${commit}` : tip}
      data-tip={tip}
      onClick={() => void copyText(commit).then(setCopied)}
    >
      <Commit size={14} aria-hidden="true" />
      {copied === null ? <code>{commit.slice(0, 7)}</code> : <span>{tip}</span>}
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
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
        <div className="diff-toolbar-lead">
          <ModePicker mode={diff.mode} commit={diff.range.kind === "commit" ? diff.range.commit : null} disabled={!workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onSetMode={onSetMode} />
          {diff.range.kind === "commit" && <LinkedCommit commit={diff.range.commit} />}
        </div>
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
          <button type="button" aria-label="Hide spacing changes" aria-pressed={diff.ignoreWhitespace} className={diff.ignoreWhitespace ? "on" : ""} data-tip={diff.ignoreWhitespace ? "Spacing changes hidden" : "Hide spacing changes"} onClick={onToggleWhitespace}><Pilcrow size={16} /></button>
          <button type="button" aria-label="Refresh changes" aria-busy={diff.loading || undefined} data-tip={diff.loading ? "Refreshing…" : "Refresh"} onClick={onRefresh}><SpinningIcon icon={RefreshCw} spinning={diff.loading} size={16} /></button>
          <ReviewKeys openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />
        </div>
      </div>
      {diff.mode === "branch" && <div className="diff-compare">
        <SidePicker id={COMPARE_MENU} label="Compare" role="From" value={range.compare ?? ""} extra={WORKING_SIDE} currentBranch={currentBranch} workspaceId={workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onPick={(compare) => onSetRange({ ...range, compare: compare || null })} />
        <ArrowRight className="diff-range-arrow" size={14} aria-hidden="true" />
        <SidePicker id={BASE_MENU} label="Target branch" role="Into" value={range.base} extra={HEAD_SIDE} workspaceId={workspaceId} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onPick={(base) => onSetRange({ ...range, base })} />
      </div>}
    </header>
  );
}
