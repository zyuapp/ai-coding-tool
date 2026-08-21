import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, Check, ChevronDown, ChevronRight, Columns2, FilePlus2, FileMinus2, FilePen, FileSymlink, MessageSquarePlus, RefreshCw, Rows3, X } from "lucide-react";
import type { DiffSummaryResult } from "../../contracts/ipc";
import type { DiffState } from "../../application/workspace-state";
import {
  commentQuote,
  diffRows,
  fileFingerprint,
  hunkText,
  hunkTextIndex,
  languageForPath,
  splitRows,
  UNCOMMITTED,
  type DiffFile,
  type DiffFileSummary,
  type DiffRange,
  type DiffRow,
  type DiffSide,
  type SplitRow,
} from "../../domain/diff";
import { highlightBlock, type ThemedToken } from "../diff/highlight";
import { usePatches, type PatchRequest, type PatchState } from "../diff/use-patch";
import { BranchMenu, useBranches } from "./BranchMenu";
import { useDismissibleLayer } from "../focus";

const BASE_MENU = "diff:base";
const COMPARE_MENU = "diff:compare";

/** The two sides that are not branches: the commit the checkout is on, and what is on disk right now. */
const HEAD_SIDE = { label: "HEAD (this checkout)", value: "HEAD" };
const WORKING_SIDE = { label: "Working tree", value: "" };

/** What an unwrapped line costs. Rows wrap, so the windowing measures each one and corrects this. */
const ROW_HEIGHT = 20;

/** Above this many rows the review is windowed; a short one is cheaper, and steadier, drawn whole. */
const VIRTUALIZE_ABOVE = 200;

export type DiffPanelProps = {
  diff: DiffState;
  workspaceId?: string;
  onSetRange: (range: DiffRange) => void;
  onSetCollapsed: (path: string, collapsed: boolean) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
  onSetSplit: (split: boolean) => void;
  onRefresh: () => void;
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

/** What a patch that is not lines to read has to say instead. */
function patchNote(patch: PatchState | undefined) {
  if (!patch || patch.status === "reading") return "Reading the patch…";
  if (patch.status === "error") return patch.message;
  if (patch.status === "too-large") return `Patch is larger than ${Math.round(patch.limit / 1_000_000)} MB — open it in your editor.`;
  return null;
}

type SidePickerProps = {
  id: string;
  label: string;
  /** The side as it is being compared: a branch name, or the extra option's own value. */
  value: string;
  extra: { label: string; value: string };
  workspaceId?: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onPick: (value: string) => void;
};

/** One side of the comparison: the branches the checkout knows, plus the one thing that is not a branch. */
function SidePicker({ id, label, value, extra, workspaceId, openMenu, onSetOpenMenu, onPick }: SidePickerProps) {
  const open = openMenu === id;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  const branches = useBranches(workspaceId, open);

  return (
    <div ref={row} className="diff-side" data-popover-menu>
      <button
        ref={trigger}
        className="diff-side-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!workspaceId}
        onClick={() => onSetOpenMenu(open ? null : id)}
      >
        <code title={value === extra.value ? extra.label : value}>{value === extra.value ? extra.label : value}</code>
        <ChevronDown size={13} />
      </button>
      {open && (
        <BranchMenu
          menuRef={menu}
          anchor={row.current}
          branches={branches}
          includeRemotes
          extra={extra}
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

/**
 * One file's patch as everything drawing it needs: the rows in one column and in two, the tokens they
 * are coloured with, and where each row sits in the one order a selection is measured in.
 */
type DrawnFile = {
  rows: DiffRow[];
  pairs: SplitRow[];
  tokens: Map<string, ThemedToken[]>;
  indexByKey: Map<string, number>;
};

function drawFile(file: DiffFile): DrawnFile {
  const rows = diffRows(file);
  return {
    rows,
    pairs: splitRows(file),
    tokens: tokenizeFile(file),
    indexByKey: new Map(rows.map((row, index) => [row.key, index])),
  };
}

/** Where a comment is being taken: a file, and a run of its rows in the order one column draws them. */
type Selection = { path: string; from: number; to: number };

/** Every drawn line of the panel, flat, so one window covers the whole review rather than each file. */
type PanelRow =
  | { kind: "file"; key: string; file: DiffFileSummary }
  | { kind: "note"; key: string; text: string }
  | { kind: "line"; key: string; path: string; row: DiffRow; index: number }
  | { kind: "pair"; key: string; path: string; row: SplitRow };

type LineRowProps = {
  row: DiffRow;
  tokens: Map<string, ThemedToken[]>;
  selected: boolean;
  onSelect: (extend: boolean) => void;
};

/** One line of the one-column view. Its gutter is the only thing that selects, the way a review reads. */
function LineRow({ row, tokens, selected, onSelect }: LineRowProps) {
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
      <span className="diff-marker" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "}</span>
      <code><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

type SplitCellProps = {
  row: DiffRow | null;
  tokens: Map<string, ThemedToken[]>;
  side: DiffSide;
  selected: boolean;
  onSelect: (extend: boolean) => void;
};

/** One column of the two-column view. Either side's gutter selects, and both colour the same way. */
function SplitCell({ row, tokens, side, selected, onSelect }: SplitCellProps) {
  if (!row || row.kind === "hunk") return <div className="diff-split-cell empty" />;
  return (
    <div className={`diff-split-cell ${row.kind}${selected ? " selected" : ""}`}>
      <button
        className="diff-gutter static"
        type="button"
        aria-label={`Line ${side === "old" ? row.oldLine : row.newLine}`}
        onClick={(event) => onSelect(event.shiftKey)}
      >
        {side === "old" ? row.oldLine ?? "" : row.newLine ?? ""}
      </button>
      <code><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

export function DiffPanel({
  diff,
  workspaceId,
  onSetRange,
  onSetCollapsed,
  onSetViewed,
  onSetSplit,
  onRefresh,
  onOpenFile,
  onComment,
  openMenu,
  onSetOpenMenu,
}: DiffPanelProps) {
  const available = diff.result?.status === "available" ? diff.result : null;
  const files = useMemo(() => available?.files ?? [], [available]);
  const collapsed = useMemo(() => new Set(diff.collapsed), [diff.collapsed]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [note, setNote] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Only the files that are open and have lines in them are worth reading a patch for. */
  const requests = useMemo<PatchRequest[]>(
    () => files
      .filter((file) => !file.binary && !collapsed.has(file.path))
      .map((file) => ({ path: file.path, version: `${file.path}|${fileFingerprint(file)}` })),
    [files, collapsed],
  );
  const { patches, at } = usePatches(workspaceId, diff.range, requests);
  const versionOf = useMemo(() => new Map(files.map((file) => [file.path, `${file.path}|${fileFingerprint(file)}`])), [files]);

  const drawn = useMemo(() => {
    const built = new Map<string, DrawnFile>();
    for (const request of requests) {
      const patch = at(request.version);
      if (patch?.status === "available") built.set(request.path, drawFile(patch.file));
    }
    return built;
    // `at` reads `patches`, which is a fresh map whenever one has landed.
  }, [requests, patches]);

  const rows = useMemo(() => {
    const panel: PanelRow[] = [];
    for (const file of files) {
      panel.push({ kind: "file", key: `f:${file.path}`, file });
      if (collapsed.has(file.path)) continue;
      if (file.binary) {
        panel.push({ kind: "note", key: `n:${file.path}`, text: "Binary file" });
        continue;
      }
      const drawing = drawn.get(file.path);
      if (!drawing) {
        panel.push({ kind: "note", key: `n:${file.path}`, text: patchNote(at(versionOf.get(file.path) ?? "")) ?? "Reading the patch…" });
        continue;
      }
      if (diff.split) {
        for (const row of drawing.pairs) panel.push({ kind: "pair", key: `${file.path}:${row.key}`, path: file.path, row });
      } else {
        drawing.rows.forEach((row, index) => panel.push({ kind: "line", key: `${file.path}:${row.key}`, path: file.path, row, index }));
      }
    }
    return panel;
  }, [files, collapsed, drawn, patches, versionOf, diff.split]);

  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 24,
    initialRect: { width: 420, height: 720 },
  });

  /** A comparison that changes is a different set of lines, so a range picked in the last one is gone. */
  useEffect(() => {
    setSelection(null);
    setNote("");
  }, [diff.range, diff.split]);

  const selectedRows = selection ? drawn.get(selection.path)?.rows.slice(selection.from, selection.to + 1) ?? [] : [];
  const quote = selection && selectedRows.length > 0 ? commentQuote(selection.path, selectedRows, selectionSide(selectedRows)) : null;

  const select = (path: string, index: number, extend: boolean) => {
    setSelection((current) => extend && current?.path === path
      ? { path, from: Math.min(current.from, index), to: Math.max(current.to, index) }
      : { path, from: index, to: index });
  };

  const selectByKey = (path: string, key: string, extend: boolean) => {
    const index = drawn.get(path)?.indexByKey.get(key);
    if (index !== undefined) select(path, index, extend);
  };

  const isSelected = (path: string, index: number | undefined) =>
    index !== undefined && selection?.path === path && index >= selection.from && index <= selection.to;

  const clear = () => {
    setSelection(null);
    setNote("");
  };

  const comment = () => {
    if (!quote) return;
    onComment(quote, note.trim());
    clear();
  };

  /** One panel row, drawn the same whether the review is windowed or laid out whole. */
  const draw = (row: PanelRow) => {
    if (row.kind === "file") {
      return (
        <FileHeader
          file={row.file}
          open={!collapsed.has(row.file.path)}
          viewed={Boolean(diff.viewed[row.file.path])}
          onToggle={() => onSetCollapsed(row.file.path, !collapsed.has(row.file.path))}
          onOpenFile={onOpenFile}
          onSetViewed={onSetViewed}
        />
      );
    }
    if (row.kind === "note") return <p className="diff-note">{row.text}</p>;
    const tokens = drawn.get(row.path)?.tokens ?? EMPTY_TOKENS;
    if (row.kind === "line") {
      return (
        <LineRow
          row={row.row}
          tokens={tokens}
          selected={isSelected(row.path, row.index)}
          onSelect={(extend) => select(row.path, row.index, extend)}
        />
      );
    }
    if (row.row.kind === "hunk") return <div className="diff-line hunk">{row.row.text}</div>;
    const { left, right } = row.row;
    const indexOf = (side: DiffRow | null) => side ? drawn.get(row.path)?.indexByKey.get(side.key) : undefined;
    return (
      <div className="diff-split-row">
        <SplitCell
          row={left}
          tokens={tokens}
          side="old"
          selected={isSelected(row.path, indexOf(left))}
          onSelect={(extend) => left && selectByKey(row.path, left.key, extend)}
        />
        <SplitCell
          row={right}
          tokens={tokens}
          side="new"
          selected={isSelected(row.path, indexOf(right))}
          onSelect={(extend) => right && selectByKey(row.path, right.key, extend)}
        />
      </div>
    );
  };

  const viewedCount = files.filter((file) => diff.viewed[file.path]).length;
  const message = summaryMessage(diff.result, workspaceId);
  const base = diff.range.kind === "uncommitted" ? HEAD_SIDE.value : diff.range.base;
  const compare = diff.range.kind === "uncommitted" ? WORKING_SIDE.value : diff.range.compare ?? WORKING_SIDE.value;
  const rangeFrom = (nextBase: string, nextCompare: string): DiffRange =>
    nextBase === HEAD_SIDE.value && nextCompare === WORKING_SIDE.value
      ? UNCOMMITTED
      : { kind: "branches", base: nextBase, compare: nextCompare === WORKING_SIDE.value ? null : nextCompare };

  return (
    <section className="diff-panel" aria-label="Changes">
      <header className="diff-toolbar">
        <div className="diff-compare">
          <SidePicker
            id={BASE_MENU}
            label="Base"
            value={base}
            extra={HEAD_SIDE}
            {...(workspaceId ? { workspaceId } : {})}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            onPick={(picked) => onSetRange(rangeFrom(picked, compare))}
          />
          <ArrowRight size={13} aria-hidden="true" />
          <SidePicker
            id={COMPARE_MENU}
            label="Compare"
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

      {available && files.length > 0 && (
        <p className="diff-progress">
          <span>{viewedCount} of {files.length} viewed</span>
          <span className="change-counts"><strong>+{available.additions}</strong><em>−{available.deletions}</em></span>
        </p>
      )}
      {message && <p className="session-note">{message}</p>}

      <div className="diff-files" ref={scrollRef} aria-label="Changed files">
        {!windowed && rows.map((row) => <div key={row.key}>{draw(row)}</div>)}
        {windowed && (
          <div className="diff-window" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => rows[item.index] ? (
              <div
                className="diff-window-row"
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {draw(rows[item.index])}
              </div>
            ) : null)}
          </div>
        )}
      </div>

      {quote && (
        <form
          className="diff-comment"
          onSubmit={(event) => {
            event.preventDefault();
            comment();
          }}
        >
          <span className="diff-comment-range">{quote.split("\n")[0]}</span>
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
    </section>
  );
}

const EMPTY_TOKENS = new Map<string, ThemedToken[]>();

type FileHeaderProps = {
  file: DiffFileSummary;
  open: boolean;
  viewed: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
};

/** The row a file is headed by: what happened to it, what it cost, and whether it has been read. */
function FileHeader({ file, open, viewed, onToggle, onOpenFile, onSetViewed }: FileHeaderProps) {
  const { folder, name } = splitPath(file.path);
  return (
    <div className={`diff-file-row ${viewed ? "viewed" : ""}`.trimEnd()}>
      <button className="diff-file-open" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="diff-file-caret" aria-hidden="true">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
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
  );
}
