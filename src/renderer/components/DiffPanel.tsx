import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Columns2, FilePlus2, FileMinus2, FilePen, FileSymlink, MessageSquarePlus, RefreshCw, Rows3, X } from "lucide-react";
import type { DiffSummaryResult } from "../../contracts/ipc";
import type { DiffState } from "../../application/workspace-state";
import {
  commentQuote,
  diffRows,
  hunkText,
  hunkTextIndex,
  languageForPath,
  rangeLabel,
  splitRows,
  UNCOMMITTED,
  type DiffFile,
  type DiffFileSummary,
  type DiffPair,
  type DiffRange,
  type DiffRow,
  type DiffSide,
} from "../../domain/diff";
import { highlightBlock, type ThemedToken } from "../diff/highlight";
import { usePatch } from "../diff/use-patch";
import { BranchMenu, useBranches } from "./BranchMenu";
import { PopoverMenu } from "./PopoverMenu";
import { useDismissibleLayer } from "../focus";

export const RANGE_MENU = "diff:range";
const BASE_MENU = "diff:base";
const COMPARE_MENU = "diff:compare";

/** The working tree as a comparison side, which is not a branch and so is named rather than listed. */
const WORKING_TREE = "working tree";

/** Above this many rows the patch is windowed; a short file is cheaper drawn whole. */
const VIRTUALIZE_ABOVE = 60;

/** What an unwrapped line costs. Rows wrap, so the windowing measures each one and corrects this. */
const ROW_HEIGHT = 20;

export type DiffPanelProps = {
  diff: DiffState;
  workspaceId?: string;
  onSetRange: (range: DiffRange) => void;
  onSelectFile: (path: string | null) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
  onSetSplit: (split: boolean) => void;
  onRefresh: () => void;
  /** The ref the session panel counts from, which is the base a branch comparison opens on. */
  baseline?: string;
  onOpenFile: (path: string) => void;
  /** A selected range and the note taken on it, which becomes a pill in the composer. */
  onComment: (quote: string, note: string) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

function StatusIcon({ status }: { status: DiffFileSummary["status"] }) {
  if (status === "added" || status === "untracked") return <FilePlus2 size={15} />;
  if (status === "deleted") return <FileMinus2 size={15} />;
  if (status === "renamed") return <FileSymlink size={15} />;
  return <FilePen size={15} />;
}

function summaryMessage(result: DiffSummaryResult | null, workspaceId: string | undefined) {
  if (!workspaceId) return "Open a project to review changes";
  if (!result) return null;
  if (result.status === "error") return result.message;
  if (result.status === "unknown") return "Workspace is no longer registered";
  if (result.status === "unavailable") return `Workspace is ${result.reason}`;
  return result.files.length === 0 ? "Nothing has changed in this comparison" : null;
}

/** The name a path is listed under, with its folder kept quiet beside it. */
function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { folder: "", name: path } : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

type BranchPickerProps = {
  id: string;
  label: string;
  value: string;
  workspaceId?: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onPick: (branch: string) => void;
  /** Offered above the branches, for the side that can also be whatever is on disk right now. */
  extra?: string;
};

function BranchPicker({ id, label, value, workspaceId, openMenu, onSetOpenMenu, onPick, extra }: BranchPickerProps) {
  const open = openMenu === id;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  const branches = useBranches(workspaceId, open);

  return (
    <div ref={row} className="diff-branch" data-popover-menu>
      <button
        ref={trigger}
        className="diff-branch-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!workspaceId}
        onClick={() => onSetOpenMenu(open ? null : id)}
      >
        <span className="diff-branch-label">{label}</span>
        <code title={value}>{value}</code>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          {extra && (
            <button
              className="diff-branch-extra"
              type="button"
              onClick={() => {
                onSetOpenMenu(null);
                onPick(extra);
              }}
            >
              {extra}
              {value === extra && <Check size={13} />}
            </button>
          )}
          <BranchMenu
            menuRef={menu}
            anchor={row.current}
            branches={branches}
            selected={value === extra ? null : value}
            onPick={(branch) => {
              onSetOpenMenu(null);
              onPick(branch);
            }}
          />
        </>
      )}
    </div>
  );
}

/** What a row's text becomes once a grammar has read the block it came from. */
function RowText({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens) return <>{text || " "}</>;
  return <>{tokens.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content}</span>)}</>;
}

/**
 * Every row's tokens, taken a hunk at a time. A hunk is contiguous, so a string or a comment that
 * opens inside one closes inside it too; a line tokenized on its own would have lost that.
 */
function tokenizeFile(file: DiffFile) {
  const lang = languageForPath(file.path);
  const tokens = new Map<string, ThemedToken[]>();
  if (!lang) return tokens;
  file.hunks.forEach((hunk, index) => {
    for (const side of ["old", "new"] as const) {
      const lines = highlightBlock(hunkText(hunk, side), lang);
      if (!lines) continue;
      for (const [key, line] of hunkTextIndex(hunk, side)) {
        const drawn = lines[line];
        if (drawn) tokens.set(`${index}:${key}`, drawn);
      }
    }
  });
  return tokens;
}

/** Which side a selection names: the old one only when every line in it was taken away. */
function selectionSide(rows: DiffRow[]): DiffSide {
  const lines = rows.filter((row) => row.kind !== "hunk");
  return lines.length > 0 && lines.every((row) => row.kind === "delete") ? "old" : "new";
}

type UnifiedRowProps = {
  row: DiffRow;
  tokens: ThemedToken[] | undefined;
  selected: boolean;
  onSelect: (extend: boolean) => void;
};

/** One line of the unified view. Its gutter is the only thing that selects, the way a review reads. */
function UnifiedRow({ row, tokens, selected, onSelect }: UnifiedRowProps) {
  if (row.kind === "hunk") return <div className="diff-line hunk">{row.text}</div>;
  return (
    <div className={`diff-line ${row.kind}${selected ? " selected" : ""}`}>
      <button
        className="diff-gutter"
        type="button"
        aria-label={`Line ${row.newLine ?? row.oldLine}`}
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <span>{row.oldLine ?? ""}</span>
        <span>{row.newLine ?? ""}</span>
      </button>
      <span className="diff-marker" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "delete" ? "\u2212" : " "}</span>
      <code><RowText text={row.text} tokens={tokens} /></code>
    </div>
  );
}

/** One column of the two-column view, which selects nothing: a comment names a row, and a pair is two. */
function SplitCell({ row, tokens, side }: { row: DiffRow | null; tokens: Map<string, ThemedToken[]>; side: DiffSide }) {
  if (!row || row.kind === "hunk") return <div className="diff-split-cell empty" />;
  return (
    <div className={`diff-split-cell ${row.kind}`}>
      <span className="diff-gutter static">{side === "old" ? row.oldLine ?? "" : row.newLine ?? ""}</span>
      <code><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

function SplitView({ file, tokens }: { file: DiffFile; tokens: Map<string, ThemedToken[]> }) {
  const pairs = useMemo(() => splitRows(file), [file]);
  return (
    <>
      {pairs.map((pair) => "kind" in pair && pair.kind === "hunk"
        ? <div className="diff-line hunk" key={pair.key}>{pair.text}</div>
        : (
          <div className="diff-split-row" key={pair.key}>
            <SplitCell row={(pair as DiffPair).left} tokens={tokens} side="old" />
            <SplitCell row={(pair as DiffPair).right} tokens={tokens} side="new" />
          </div>
        ))}
    </>
  );
}

type FileViewProps = {
  path: string;
  file: DiffFile;
  split: boolean;
  onComment: (quote: string, note: string) => void;
};

/** The open file: its rows, and the bar a selected range is commented from. */
function FileView({ path, file, split, onComment }: FileViewProps) {
  const rows = useMemo(() => diffRows(file), [file]);
  const tokens = useMemo(() => tokenizeFile(file), [file]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  /** A fresh file is a fresh set of rows, so a range selected in the last one no longer names lines. */
  useLayoutEffect(() => {
    setAnchor(null);
    setHead(null);
    setNote("");
  }, [file]);

  const selection = anchor === null || head === null ? null : { from: Math.min(anchor, head), to: Math.max(anchor, head) };
  const selected = selection ? rows.slice(selection.from, selection.to + 1) : [];
  const windowed = !split && rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 20,
    initialRect: { width: 420, height: 720 },
  });

  const select = (index: number, extend: boolean) => {
    if (extend && anchor !== null) setHead(index);
    else {
      setAnchor(index);
      setHead(index);
    }
  };

  const clear = () => {
    setAnchor(null);
    setHead(null);
    setNote("");
  };

  const comment = () => {
    if (selected.length === 0) return;
    onComment(commentQuote(path, selected, selectionSide(selected)), note.trim());
    clear();
  };

  return (
    <div className="diff-file-view">
      <div className="diff-scroll" ref={scrollRef}>
        {split && <SplitView file={file} tokens={tokens} />}
        {!split && !windowed && rows.map((row, index) => (
          <UnifiedRow
            key={row.key}
            row={row}
            tokens={tokens.get(row.key)}
            selected={selection !== null && index >= selection.from && index <= selection.to}
            onSelect={(extend) => select(index, extend)}
          />
        ))}
        {!split && windowed && (
          <div className="diff-window" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                className="diff-window-row"
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <UnifiedRow
                  row={rows[item.index]}
                  tokens={tokens.get(rows[item.index].key)}
                  selected={selection !== null && item.index >= selection.from && item.index <= selection.to}
                  onSelect={(extend) => select(item.index, extend)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {selection && (
        <form
          className="diff-comment"
          onSubmit={(event) => {
            event.preventDefault();
            comment();
          }}
        >
          <span className="diff-comment-range">{commentQuote(path, selected, selectionSide(selected)).split("\n")[0]}</span>
          <input
            aria-label="Note on the selected lines"
            placeholder="What should change here?"
            autoFocus
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
          <button type="submit" aria-label="Comment on the selected lines"><MessageSquarePlus size={15} /></button>
          <button type="button" aria-label="Clear the selection" onClick={clear}><X size={15} /></button>
        </form>
      )}
    </div>
  );
}

export function DiffPanel({
  diff,
  workspaceId,
  onSetRange,
  onSelectFile,
  onSetViewed,
  onSetSplit,
  onRefresh,
  baseline,
  onOpenFile,
  onComment,
  openMenu,
  onSetOpenMenu,
}: DiffPanelProps) {
  const patch = usePatch(workspaceId, diff.range, diff.file);
  const available = diff.result?.status === "available" ? diff.result : null;
  const files = available?.files ?? [];
  const viewedCount = files.filter((file) => diff.viewed[file.path]).length;
  const message = summaryMessage(diff.result, workspaceId);
  const branches = diff.range.kind === "branches" ? diff.range : null;

  return (
    <section className="diff-panel" aria-label="Changes">
      <header className="diff-toolbar">
        <PopoverMenu
          id={RANGE_MENU}
          openMenu={openMenu}
          onSetOpenMenu={onSetOpenMenu}
          label="What to compare"
          className="diff-range"
          popoverClassName="session-menu-popover"
          items={[
            { label: "Uncommitted changes", onSelect: () => onSetRange(UNCOMMITTED) },
            { label: "Compare branches", onSelect: () => onSetRange({ kind: "branches", base: branches?.base ?? baseline ?? "main", compare: branches?.compare ?? null }) },
          ]}
        >
          <span>{rangeLabel(diff.range)}</span>
          <ChevronDown size={13} />
        </PopoverMenu>
        <div className="diff-toolbar-actions">
          <button
            type="button"
            aria-label={diff.split ? "Show one column" : "Show two columns"}
            aria-pressed={diff.split}
            className={diff.split ? "on" : ""}
            onClick={() => onSetSplit(!diff.split)}
          >
            {diff.split ? <Rows3 size={15} /> : <Columns2 size={15} />}
          </button>
          <button type="button" aria-label="Read the comparison again" onClick={onRefresh}>
            <RefreshCw size={15} className={diff.loading ? "spinning" : ""} />
          </button>
        </div>
      </header>

      {branches && (
        <div className="diff-branches">
          <BranchPicker
            id={BASE_MENU}
            label="Base"
            value={branches.base}
            {...(workspaceId ? { workspaceId } : {})}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            onPick={(branch) => onSetRange({ ...branches, base: branch })}
          />
          <BranchPicker
            id={COMPARE_MENU}
            label="Compare"
            value={branches.compare ?? WORKING_TREE}
            {...(workspaceId ? { workspaceId } : {})}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            extra={WORKING_TREE}
            onPick={(branch) => onSetRange({ ...branches, compare: branch === WORKING_TREE ? null : branch })}
          />
        </div>
      )}

      {available && files.length > 0 && (
        <p className="diff-progress">
          <span>{viewedCount} of {files.length} viewed</span>
          <span className="change-counts"><strong>+{available.additions}</strong><em>−{available.deletions}</em></span>
        </p>
      )}
      {message && <p className="session-note">{message}</p>}

      <div className="diff-files" role="list" aria-label="Changed files">
        {files.map((file) => {
          const { folder, name } = splitPath(file.path);
          const open = diff.file === file.path;
          const viewed = Boolean(diff.viewed[file.path]);
          return (
            <div className={`diff-file ${open ? "open" : ""}${viewed ? " viewed" : ""}`.trimEnd()} role="listitem" key={file.path}>
              <div className="diff-file-row">
                <button
                  className="diff-file-open"
                  type="button"
                  aria-expanded={open}
                  onClick={() => onSelectFile(open ? null : file.path)}
                >
                  <span className="diff-file-icon"><StatusIcon status={file.status} /></span>
                  <span className="diff-file-name" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
                    <em>{folder}</em>{name}
                  </span>
                  {!file.binary && <span className="change-counts"><strong>+{file.additions}</strong><em>−{file.deletions}</em></span>}
                </button>
                <button
                  className="diff-file-editor"
                  type="button"
                  aria-label={`Open ${file.path} in your editor`}
                  onClick={() => onOpenFile(file.path)}
                >
                  <FileSymlink size={14} />
                </button>
                <label className="diff-file-viewed">
                  <input
                    type="checkbox"
                    aria-label={`Mark ${file.path} viewed`}
                    checked={viewed}
                    onChange={(event) => onSetViewed(file.path, event.currentTarget.checked)}
                  />
                  <Check size={14} aria-hidden="true" />
                </label>
              </div>
              {open && file.binary && <p className="diff-note">Binary file</p>}
              {open && !file.binary && patch?.status === "reading" && <p className="diff-note">Reading the patch…</p>}
              {open && !file.binary && patch?.status === "error" && <p className="diff-note">{patch.message}</p>}
              {open && !file.binary && patch?.status === "too-large" && <p className="diff-note">Patch is larger than {Math.round(patch.limit / 1_000_000)} MB — open it in your editor.</p>}
              {open && !file.binary && patch?.status === "available" && (
                <FileView path={file.path} file={patch.file} split={diff.split} onComment={onComment} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
