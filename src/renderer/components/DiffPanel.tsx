import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Columns2, MessageSquarePlus, RefreshCw, Rows3 } from "lucide-react";
import type { DiffSummaryResult } from "../../contracts/ipc";
import type { DiffState } from "../../application/workspace-state";
import type { Annotation, AnnotationAnchor } from "../../domain/task";
import {
  commentQuote,
  diffRows,
  fileFingerprint,
  hunkText,
  hunkTextIndex,
  languageForPath,
  lineOn,
  rangeKey,
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
import { highlightBlock, withinHighlightBudget, type ThemedToken } from "../diff/highlight";
import { usePatches, type PatchRequest, type PatchState } from "../diff/use-patch";
import { BranchMenu, useBranches } from "./BranchMenu";
import { FileHeader } from "./DiffFileRow";
import { DiffCommentEditor } from "./DiffCommentEditor";
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
  annotations: Annotation[];
  /** A selected range and the note taken on it, which becomes a pill in the composer. */
  onComment: (quote: string, note: string, anchor: AnnotationAnchor) => void;
  onEditComment: (annotationId: string, note: string) => void;
  onRemoveComment: (annotationId: string) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

function summaryMessage(result: DiffSummaryResult | null, loading: boolean, workspaceId: string | undefined) {
  if (!workspaceId) return "Open a project to review changes";
  /** A first read has nothing to draw, so one quiet line says why the list is not there yet. */
  if (!result) return loading ? "Reading the comparison…" : null;
  if (result.status === "error") return result.message;
  if (result.status === "unknown") return "Workspace is no longer registered";
  if (result.status === "unavailable") return `Workspace is ${result.reason}`;
  return result.files.length === 0 ? "Nothing has changed in this comparison" : null;
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
  if (!lang || !withinHighlightBudget(file)) return tokens;
  for (const hunk of file.hunks) {
    for (const side of ["old", "new"] as const) {
      const lines = highlightBlock(hunkText(hunk, side), lang);
      if (!lines) continue;
      for (const [key, line] of hunkTextIndex(hunk, side)) {
        const drawn = lines[line];
        if (drawn) tokens.set(key, drawn);
      }
    }
  }
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

type DiffComment = {
  annotation: Annotation;
  number: number;
  path: string;
  from: number;
  to: number;
  marker: number;
  side: DiffSide;
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

function anchoredDiffComments(annotations: Annotation[], comparison: string, drawn: Map<string, DrawnFile>) {
  return annotations.flatMap((annotation, index): DiffComment[] => {
    const anchor = annotation.anchor;
    if (anchor?.kind !== "diff" || anchor.comparison !== comparison) return [];
    const drawing = drawn.get(anchor.path);
    const start = drawing?.indexByKey.get(anchor.start);
    const end = drawing?.indexByKey.get(anchor.end);
    if (!drawing || start === undefined || end === undefined) return [];
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const selected = drawing.rows.slice(from, to + 1);
    if (selected.some((row) => row.kind === "hunk") || commentQuote(anchor.path, selected, anchor.side) !== annotation.quote) return [];
    const marker = [...selected].reverse().find((row) => lineOn(row, anchor.side) !== null);
    const markerIndex = marker ? drawing.indexByKey.get(marker.key) : undefined;
    return [{ annotation, number: index + 1, path: anchor.path, from, to, marker: markerIndex ?? to, side: anchor.side }];
  });
}

function indexDiffComments(comments: DiffComment[]) {
  const highlighted = new Set<string>();
  const markers = new Map<string, DiffComment[]>();
  for (const comment of comments) {
    for (let index = comment.from; index <= comment.to; index += 1) highlighted.add(`${comment.path}\n${index}`);
    const key = `${comment.path}\n${comment.marker}`;
    markers.set(key, [...(markers.get(key) ?? []), comment]);
  }
  return { highlighted, markers };
}

function diffAnchor(range: DiffRange, selection: Selection, rows: DiffRow[]): AnnotationAnchor {
  return {
    kind: "diff",
    comparison: rangeKey(range),
    path: selection.path,
    start: selection.anchor,
    end: selection.head,
    side: selectionSide(rows),
  };
}

/**
 * Where a comment is being taken: a file, and the two rows its run is bounded by. Rows are named by
 * key rather than by position, so a patch read again under the user either still has those rows or
 * the selection is dropped — it can never quietly come to mean different lines.
 */
type Selection = { path: string; anchor: string; head: string };

/**
 * Every drawn line of the panel, flat, so one window covers the whole review rather than each file.
 * Every row names the file it belongs to, which is what the pinned header reads off the top edge.
 */
type PanelRow =
  | { kind: "file"; key: string; path: string; file: DiffFileSummary }
  | { kind: "note"; key: string; path: string; text: string }
  | { kind: "line"; key: string; path: string; row: DiffRow; index: number }
  | { kind: "pair"; key: string; path: string; row: SplitRow }
  /** The note being written, drawn under the run it is about rather than docked away from it. */
  | { kind: "composer"; key: string; path: string };

/**
 * Which row sits under the top edge of the review. The windowed list is drawn out of flow, so its
 * rows are found through the window's own measurements; a short list is in flow and found by offset.
 */
function topRowAt(scroller: HTMLDivElement, windowed: boolean, virtualizer: Virtualizer<HTMLDivElement, Element>) {
  const offset = scroller.scrollTop;
  if (windowed) return virtualizer.getVirtualItemForOffset(offset)?.index ?? null;
  const drawn = scroller.children;
  if (drawn.length === 0) return null;
  let low = 0;
  let high = drawn.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((drawn[mid] as HTMLElement).offsetTop <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

type LineRowProps = {
  row: DiffRow;
  tokens: Map<string, ThemedToken[]>;
  selected: boolean;
  commented: boolean;
  comments: DiffComment[];
  onSelect: (extend: boolean) => void;
  onEditComment: (comment: DiffComment) => void;
};

/** One line of the one-column view. Its gutter is the only thing that selects, the way a review reads. */
function LineRow({ row, tokens, selected, commented, comments, onSelect, onEditComment }: LineRowProps) {
  if (row.kind === "hunk") return <div className="diff-line hunk">{row.text}</div>;
  return (
    <div className={`diff-line ${row.kind}${commented ? " commented" : ""}${selected ? " selected" : ""}`}>
      {comments.length > 0 && (
        <span className="diff-inline-comment-markers">
          {comments.map((comment) => (
            <button
              key={comment.annotation.id}
              type="button"
              aria-label={`Edit comment ${comment.number} on ${rowLabel(row).toLowerCase()}`}
              onClick={() => onEditComment(comment)}
            >
              {comment.number}
            </button>
          ))}
        </span>
      )}
      <button
        className="diff-gutter"
        type="button"
        aria-label={`Add comment on ${rowLabel(row).toLowerCase()}`}
        title="Add comment. Shift-click to select a range."
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <i className="diff-comment-affordance" aria-hidden="true"><MessageSquarePlus size={12} /></i>
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
  commented: boolean;
  comments: DiffComment[];
  onSelect: (extend: boolean) => void;
  onEditComment: (comment: DiffComment) => void;
};

/** One column of the two-column view. Either side's gutter selects, and both colour the same way. */
function SplitCell({ row, tokens, side, selected, commented, comments, onSelect, onEditComment }: SplitCellProps) {
  if (!row || row.kind === "hunk") return <div className="diff-split-cell empty" />;
  return (
    <div className={`diff-split-cell ${row.kind}${commented ? " commented" : ""}${selected ? " selected" : ""}`}>
      {comments.length > 0 && (
        <span className="diff-inline-comment-markers">
          {comments.map((comment) => (
            <button
              key={comment.annotation.id}
              type="button"
              aria-label={`Edit comment ${comment.number} on ${rowLabel(row).toLowerCase()}`}
              onClick={() => onEditComment(comment)}
            >
              {comment.number}
            </button>
          ))}
        </span>
      )}
      <button
        className="diff-gutter static"
        type="button"
        aria-label={`Add comment on ${rowLabel(row).toLowerCase()}`}
        title="Add comment. Shift-click to select a range."
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <i className="diff-comment-affordance" aria-hidden="true"><MessageSquarePlus size={12} /></i>
        <span>{side === "old" ? row.oldLine ?? "" : row.newLine ?? ""}</span>
      </button>
      <code><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

type SplitPairRowProps = {
  path: string;
  left: DiffRow | null;
  right: DiffRow | null;
  tokens: Map<string, ThemedToken[]>;
  indexByKey: Map<string, number> | undefined;
  comments: ReturnType<typeof indexDiffComments>;
  isSelected: (path: string, index: number | undefined) => boolean;
  onSelect: (key: string, extend: boolean) => void;
  onEditComment: (comment: DiffComment) => void;
};

/** One line of the two-column view: the old side beside the new, either of which can be missing. */
function SplitPairRow({ path, left, right, tokens, indexByKey, comments, isSelected, onSelect, onEditComment }: SplitPairRowProps) {
  const indexOf = (side: DiffRow | null) => side ? indexByKey?.get(side.key) : undefined;
  const commentsFor = (index: number | undefined, side: DiffSide) => index === undefined
    ? []
    : (comments.markers.get(`${path}\n${index}`) ?? []).filter((comment) => comment.side === side);
  const commented = (index: number | undefined) => index !== undefined && comments.highlighted.has(`${path}\n${index}`);
  const leftIndex = indexOf(left);
  const rightIndex = indexOf(right);
  return (
    <div className="diff-split-row">
      <SplitCell
        row={left}
        tokens={tokens}
        side="old"
        selected={isSelected(path, leftIndex)}
        commented={commented(leftIndex)}
        comments={commentsFor(leftIndex, "old")}
        onSelect={(extend) => left && onSelect(left.key, extend)}
        onEditComment={onEditComment}
      />
      <SplitCell
        row={right}
        tokens={tokens}
        side="new"
        selected={isSelected(path, rightIndex)}
        commented={commented(rightIndex)}
        comments={commentsFor(rightIndex, "new")}
        onSelect={(extend) => right && onSelect(right.key, extend)}
        onEditComment={onEditComment}
      />
    </div>
  );
}

/**
 * The row of the file being read, held at the top edge. It follows the list rather than leading it,
 * so a lookup by name still reaches the row the list itself holds, and it is an echo of that row:
 * the same controls under the pointer, and nothing for the keyboard or a screen reader.
 */
function PinnedFileRow({ file, open, viewed, onToggle, onOpenFile, onSetViewed }: {
  file: DiffFileSummary;
  open: boolean;
  viewed: boolean;
  onToggle: (path: string, collapsed: boolean) => void;
  onOpenFile: (path: string) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
}) {
  return (
    <div className="diff-file-pinned" aria-hidden="true">
      <FileHeader file={file} open={open} viewed={viewed} echo onToggle={() => onToggle(file.path, open)} onOpenFile={onOpenFile} onSetViewed={onSetViewed} />
    </div>
  );
}

/**
 * The file the top edge of the review is inside, and the way to look again. Its row is drawn a
 * second time over the review, so the path stays readable however far into a long file the user
 * has scrolled.
 */
function usePinnedFile(
  scroller: RefObject<HTMLDivElement | null>,
  rows: PanelRow[],
  files: DiffFileSummary[],
  windowed: boolean,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
) {
  const [path, setPath] = useState<string | null>(null);
  const sync = () => {
    const element = scroller.current;
    const index = element ? topRowAt(element, windowed, virtualizer) : null;
    setPath(index === null ? null : rows[index]?.path ?? null);
  };
  /** Rows arriving, folding, or changing column count all move the top edge without a scroll. */
  useEffect(sync, [rows, windowed]);
  return { pinned: path === null ? undefined : files.find((file) => file.path === path), sync };
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
  annotations,
  onComment,
  onEditComment,
  onRemoveComment,
  openMenu,
  onSetOpenMenu,
}: DiffPanelProps) {
  const available = diff.result?.status === "available" ? diff.result : null;
  const files = useMemo(() => available?.files ?? [], [available]);
  const collapsed = useMemo(() => new Set(diff.collapsed), [diff.collapsed]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
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

  /**
   * Whether the list is still waiting for its first patch. Nothing is drawn until one settles —
   * a note counts as settled as much as lines do — so the review lands once, with content, instead
   * of twice: bare names first, then the same names pushed apart as lines arrive under them.
   * Nothing asked for means nothing to wait for, which is how an all-binary or all-folded list paints.
   */
  const settling = useMemo(
    () => requests.length > 0 && requests.every((request) => {
      const patch = at(request.version);
      return patch === undefined || patch.status === "reading";
    }),
    // `at` reads `patches`, which is a fresh map whenever one has landed.
    [requests, patches],
  );
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

  /** Draft comments only mark the exact comparison and rows they were made from. */
  const diffComments = useMemo(() => anchoredDiffComments(annotations, rangeKey(diff.range), drawn), [annotations, diff.range, drawn]);
  const commentRows = useMemo(() => indexDiffComments(diffComments), [diffComments]);

  const rows = useMemo(() => {
    /** The hold: no names without something under at least one of them. */
    if (settling) return [];
    const panel: PanelRow[] = [];
    for (const file of files) {
      panel.push({ kind: "file", key: `f:${file.path}`, path: file.path, file });
      if (collapsed.has(file.path)) continue;
      if (file.binary) {
        panel.push({ kind: "note", key: `n:${file.path}`, path: file.path, text: "Binary file" });
        continue;
      }
      const drawing = drawn.get(file.path);
      if (drawing && drawing.rows.length === 0) {
        panel.push({ kind: "note", key: `n:${file.path}`, path: file.path, text: emptyPatchNote(file) });
        continue;
      }
      if (!drawing) {
        panel.push({ kind: "note", key: `n:${file.path}`, path: file.path, text: patchNote(at(versionOf.get(file.path) ?? "")) ?? "Reading the patch…" });
        continue;
      }
      /** The composer follows the last drawn row of the selection, whichever view drew it. */
      const commenting = span && selection?.path === file.path;
      if (split) {
        for (const row of drawing.pairs) {
          panel.push({ kind: "pair", key: `${file.path}:${row.key}`, path: file.path, row });
          const reached = row.kind === "pair" && [row.left, row.right].some((side) => side && drawing.indexByKey.get(side.key) === span?.to);
          if (commenting && reached) panel.push({ kind: "composer", key: `c:${file.path}`, path: file.path });
        }
      } else {
        drawing.rows.forEach((row, index) => {
          panel.push({ kind: "line", key: `${file.path}:${row.key}`, path: file.path, row, index });
          if (commenting && index === span.to) panel.push({ kind: "composer", key: `c:${file.path}`, path: file.path });
        });
      }
    }
    return panel;
  }, [settling, files, collapsed, drawn, patches, versionOf, split, span, selection?.path]);

  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 24,
    initialRect: { width: 420, height: 720 },
  });

  const { pinned, sync: syncPinned } = usePinnedFile(scrollRef, rows, files, windowed, virtualizer);

  /** The caret goes to the note when a run is first picked, and stays wherever the user puts it after. */
  useEffect(() => {
    if (selection) noteRef.current?.focus();
  }, [selection?.path, selection?.anchor]);

  /** A comparison that changes is a different set of lines, so a range picked in the last one is gone. */
  useEffect(() => { setSelection(null); setNote(""); setEditing(null); }, [diff.range]);
  const quote = selection && span?.rows.length ? commentQuote(selection.path, span.rows, selectionSide(span.rows)) : null;

  const selectByKey = (path: string, key: string, extend: boolean) => {
    if (editing) setNote("");
    setEditing(null);
    setSelection((current) => extend && current?.path === path ? { ...current, head: key } : { path, anchor: key, head: key });
  };
  const isSelected = (path: string, index: number | undefined) => index !== undefined && selection?.path === path && span !== null && index >= span.from && index <= span.to;
  const clear = () => { setSelection(null); setNote(""); setEditing(null); };

  const comment = () => {
    if (!quote || !selection || !span) return;
    if (editing) onEditComment(editing, note.trim());
    else onComment(quote, note.trim(), diffAnchor(diff.range, selection, span.rows));
    clear();
  };

  const editComment = (comment: DiffComment) => {
    const anchor = comment.annotation.anchor;
    if (anchor?.kind !== "diff") return;
    setSelection({ path: anchor.path, anchor: anchor.start, head: anchor.end });
    setNote(comment.annotation.note);
    setEditing(comment.annotation.id);
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
        <DiffCommentEditor
          quote={quote}
          note={note}
          editing={editing !== null}
          noteRef={noteRef}
          onNote={setNote}
          onSubmit={comment}
          onClear={clear}
          onRemove={() => {
            if (editing) onRemoveComment(editing);
            clear();
          }}
        />
      );
    }
    const tokens = drawn.get(row.path)?.tokens ?? EMPTY_TOKENS;
    if (row.kind === "line") {
      const key = `${row.path}\n${row.index}`;
      return (
        <LineRow
          row={row.row}
          tokens={tokens}
          selected={isSelected(row.path, row.index)}
          commented={commentRows.highlighted.has(key)}
          comments={commentRows.markers.get(key) ?? []}
          onSelect={(extend) => selectByKey(row.path, row.row.key, extend)}
          onEditComment={editComment}
        />
      );
    }
    if (row.row.kind === "hunk") return <div className="diff-line hunk">{row.row.text}</div>;
    return (
      <SplitPairRow
        path={row.path}
        left={row.row.left}
        right={row.row.right}
        tokens={tokens}
        indexByKey={drawn.get(row.path)?.indexByKey}
        comments={commentRows}
        isSelected={isSelected}
        onSelect={(key, extend) => selectByKey(row.path, key, extend)}
        onEditComment={editComment}
      />
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
      {message ? <p className="session-note">{message}</p>
        : settling ? <p className="session-note">Reading the changes…</p>
        : null}

      <div className="diff-scroll">
        <div className="diff-files" ref={scrollRef} onScroll={syncPinned} aria-label="Changed files">
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
        {pinned && <PinnedFileRow file={pinned} open={!collapsed.has(pinned.path)} viewed={Boolean(diff.viewed[pinned.path])} onToggle={onSetCollapsed} onOpenFile={onOpenFile} onSetViewed={onSetViewed} />}
      </div>

    </section>
  );
}

const EMPTY_TOKENS = new Map<string, ThemedToken[]>();
