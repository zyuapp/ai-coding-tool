import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Check, ChevronDown, ChevronRight, Columns2, FilePlus2, FileMinus2, FilePen, FileSymlink, MessageSquarePlus, RefreshCw, Rows3, X } from "lucide-react";
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
  type DiffLineKind,
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

/**
 * The two sides that are not branches: the commit the checkout is on, and what is on disk right now.
 * Both are short, because the dock is narrow and a truncated side reads as a truncated branch name.
 */
const HEAD_SIDE = { label: "HEAD", value: "HEAD" };
const WORKING_SIDE = { label: "Working tree", value: "" };

/** What an unwrapped line costs. Rows wrap, so the windowing measures each one and corrects this. */
const ROW_HEIGHT = 20;

/** Above this many rows the review is windowed; a short one is cheaper, and steadier, drawn whole. */
const VIRTUALIZE_ABOVE = 200;

/**
 * Two columns need room for two. The dock opens wider than this, so a review is side by side unless
 * the user has narrowed it; below here each side is down to a few words a line and one column reads
 * better, so the review falls back whatever the thread last chose.
 */
const SPLIT_MIN_WIDTH = 520;

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

function summaryMessage(result: DiffSummaryResult | null, loading: boolean, workspaceId: string | undefined) {
  if (!workspaceId) return "Open a project to review changes";
  /** A first read has nothing to draw, so one quiet line says why the list is not there yet. */
  if (!result) return loading ? "Reading the comparison…" : null;
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

/** Why a file can be in the list and still have no lines under it. */
function emptyPatchNote(file: DiffFileSummary) {
  if (file.additions === 0 && file.deletions === 0) return "No changes to the file's contents";
  return "Nothing to show for this comparison";
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

/**
 * What a gutter announces. A line number alone is ambiguous: a deletion and the addition replacing it
 * often carry the same number, and in two columns both sides would read the same.
 */
function rowLabel(row: Extract<DiffRow, { kind: DiffLineKind }>) {
  if (row.kind === "add") return `Added line ${row.newLine}`;
  if (row.kind === "delete") return `Removed line ${row.oldLine}`;
  return `Unchanged line ${row.newLine}`;
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

/**
 * Where a comment is being taken: a file, and the two rows its run is bounded by. Rows are named by
 * key rather than by position, so a patch read again under the user either still has those rows or
 * the selection is dropped — it can never quietly come to mean different lines.
 */
type Selection = { path: string; anchor: string; head: string };

/** Every drawn line of the panel, flat, so one window covers the whole review rather than each file. */
type PanelRow =
  | { kind: "file"; key: string; file: DiffFileSummary }
  | { kind: "note"; key: string; text: string }
  | { kind: "line"; key: string; path: string; row: DiffRow; index: number }
  | { kind: "pair"; key: string; path: string; row: SplitRow }
  /** The note being written, drawn under the run it is about rather than docked away from it. */
  | { kind: "composer"; key: string };

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
        aria-label={rowLabel(row)}
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
        aria-label={rowLabel(row)}
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <span>{side === "old" ? row.oldLine ?? "" : row.newLine ?? ""}</span>
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
  const panelRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [roomForTwo, setRoomForTwo] = useState(true);
  const split = diff.split && roomForTwo;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    /** A panel that has not been laid out yet measures zero, which is no answer rather than "too narrow". */
    const measure = () => setRoomForTwo((width) => panel.clientWidth === 0 ? width : panel.clientWidth >= SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  /** Only the files that are open and have lines in them are worth reading a patch for. */
  const requests = useMemo<PatchRequest[]>(
    () => files
      .filter((file) => !file.binary && !collapsed.has(file.path))
      .map((file) => ({
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        version: `${file.path}|${fileFingerprint(file)}`,
      })),
    [files, collapsed],
  );
  const { patches, at } = usePatches(workspaceId, diff.range, requests);
  const versionOf = useMemo(() => new Map(files.map((file) => [file.path, `${file.path}|${fileFingerprint(file)}`])), [files]);

  /**
   * Parsing and tokenizing a file is the expensive part of drawing it, so each one is kept against the
   * version it was drawn from. Without this, one patch landing would redraw every file already on
   * screen, which on a large review is the whole diff through a grammar again for every file in it.
   */
  const drawings = useRef(new Map<string, DrawnFile>());
  const drawn = useMemo(() => {
    const built = new Map<string, DrawnFile>();
    const held = drawings.current;
    const kept = new Map<string, DrawnFile>();
    for (const request of requests) {
      const patch = at(request.version);
      if (patch?.status !== "available") continue;
      const drawing = held.get(request.version) ?? drawFile(patch.file);
      kept.set(request.version, drawing);
      built.set(request.path, drawing);
    }
    drawings.current = kept;
    return built;
    // `at` reads `patches`, which is a fresh map whenever one has landed.
  }, [requests, patches]);

  /**
   * The rows a selection covers right now. Both ends have to still be in the file, and a hunk header
   * between them ends the run: a range that jumps a header would quote lines the user never saw.
   */
  const span = useMemo(() => {
    if (!selection) return null;
    const drawing = drawn.get(selection.path);
    const from = drawing?.indexByKey.get(selection.anchor);
    const to = drawing?.indexByKey.get(selection.head);
    if (!drawing || from === undefined || to === undefined) return null;
    const rows = drawing.rows.slice(Math.min(from, to), Math.max(from, to) + 1);
    return rows.some((row) => row.kind === "hunk") ? null : { rows, from: Math.min(from, to), to: Math.max(from, to) };
  }, [selection, drawn]);

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
      if (drawing && drawing.rows.length === 0) {
        panel.push({ kind: "note", key: `n:${file.path}`, text: emptyPatchNote(file) });
        continue;
      }
      if (!drawing) {
        panel.push({ kind: "note", key: `n:${file.path}`, text: patchNote(at(versionOf.get(file.path) ?? "")) ?? "Reading the patch…" });
        continue;
      }
      /** The composer follows the last drawn row of the selection, whichever view drew it. */
      const commenting = span && selection?.path === file.path;
      if (split) {
        for (const row of drawing.pairs) {
          panel.push({ kind: "pair", key: `${file.path}:${row.key}`, path: file.path, row });
          const reached = row.kind === "pair" && [row.left, row.right].some((side) => side && drawing.indexByKey.get(side.key) === span?.to);
          if (commenting && reached) panel.push({ kind: "composer", key: `c:${file.path}` });
        }
      } else {
        drawing.rows.forEach((row, index) => {
          panel.push({ kind: "line", key: `${file.path}:${row.key}`, path: file.path, row, index });
          if (commenting && index === span.to) panel.push({ kind: "composer", key: `c:${file.path}` });
        });
      }
    }
    return panel;
  }, [files, collapsed, drawn, patches, versionOf, split, span, selection?.path]);

  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 24,
    initialRect: { width: 420, height: 720 },
  });

  /** The caret goes to the note when a run is first picked, and stays wherever the user puts it after. */
  useEffect(() => {
    if (selection) noteRef.current?.focus();
  }, [selection?.path, selection?.anchor]);

  /** A comparison that changes is a different set of lines, so a range picked in the last one is gone. */
  useEffect(() => {
    setSelection(null);
    setNote("");
  }, [diff.range]);


  const quote = selection && span?.rows.length ? commentQuote(selection.path, span.rows, selectionSide(span.rows)) : null;

  const selectByKey = (path: string, key: string, extend: boolean) => {
    setSelection((current) => extend && current?.path === path ? { ...current, head: key } : { path, anchor: key, head: key });
  };

  const isSelected = (path: string, index: number | undefined) =>
    index !== undefined && selection?.path === path && span !== null && index >= span.from && index <= span.to;

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
    if (row.kind === "composer") {
      return (
        <form
          className="diff-comment"
          onSubmit={(event) => {
            event.preventDefault();
            comment();
          }}
          onKeyDown={(event) => {
            /** Escape drops the selection rather than reaching the shortcut that stops the run. */
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              clear();
              return;
            }
            /** Enter sends the note the way it sends a message; a newline needs Shift, as it does there. */
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            comment();
          }}
        >
          <header>
            <MessageSquarePlus size={13} aria-hidden="true" />
            <span className="diff-comment-range">{quote?.split("\n")[0]}</span>
            <button type="button" aria-label="Clear the selection" onClick={clear}><X size={14} /></button>
          </header>
          <textarea
            ref={noteRef}
            rows={1}
            aria-label="Note on the selected lines"
            placeholder="What should change here?"
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
          <footer>
            <span className="diff-comment-hint">Enter to add, Shift + Enter for a new line</span>
            <button className="send-button" type="submit" aria-label="Comment on the selected lines" disabled={!note.trim()}>
              <ArrowUp size={17} />
            </button>
          </footer>
        </form>
      );
    }
    const tokens = drawn.get(row.path)?.tokens ?? EMPTY_TOKENS;
    if (row.kind === "line") {
      return (
        <LineRow
          row={row.row}
          tokens={tokens}
          selected={isSelected(row.path, row.index)}
          onSelect={(extend) => selectByKey(row.path, row.row.key, extend)}
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
  const message = summaryMessage(diff.result, diff.loading, workspaceId);
  const base = diff.range.kind === "uncommitted" ? HEAD_SIDE.value : diff.range.base;
  const compare = diff.range.kind === "uncommitted" ? WORKING_SIDE.value : diff.range.compare ?? WORKING_SIDE.value;
  const rangeFrom = (nextBase: string, nextCompare: string): DiffRange =>
    nextBase === HEAD_SIDE.value && nextCompare === WORKING_SIDE.value
      ? UNCOMMITTED
      : { kind: "branches", base: nextBase, compare: nextCompare === WORKING_SIDE.value ? null : nextCompare };

  return (
    <section className="diff-panel" aria-label="Changes" ref={panelRef}>
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
            aria-label={split ? "Show one column" : "Show two columns"}
            aria-pressed={split}
            className={split ? "on" : ""}
            disabled={!roomForTwo}
            title={roomForTwo ? undefined : "Widen the panel to compare in two columns"}
            onClick={() => onSetSplit(!diff.split)}
          >
            {split ? <Rows3 size={15} /> : <Columns2 size={15} />}
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
        {file.previousPath && <span className="diff-file-renamed" title={`Renamed from ${file.previousPath}`}>renamed</span>}
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
