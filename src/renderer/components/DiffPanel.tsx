import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffSummaryResult } from "../../contracts/ipc";
import type { DiffState, FindView } from "../../application/workspace-state";
import type { FindResults } from "../../domain/find";
import type { Annotation, AnnotationAnchor } from "../../domain/conversation";
import { commentQuote, foldedForSize, rangeKey, type DiffFileSummary, type DiffRange } from "../../domain/diff";
import type { PanelRow } from "../diff/panel-rows";
import {
  anchoredDiffComments,
  colourRow,
  diffAnchor,
  indexDiffComments,
  selectionSide,
  type DiffComment,
  type Selection,
} from "../diff/panel-rows";
import { useDrawnFiles, usePanelRows, usePinnedFile, useRoomForTwo, useSelectionSpan, useTickThrough } from "../diff/use-panel";
import { useReadWholeReview, useReviewFind } from "../diff/use-review-find";
import { useLazyColours } from "../diff/use-colours";
import { DiffCommentEditor } from "./DiffCommentEditor";
import { DiffToolbar, type DiffPickerActions } from "./DiffToolbar";
import { PanelRowView, PinnedFileRow } from "./DiffRows";

/** What an unwrapped line costs. Rows wrap, so the windowing measures each one and corrects this. */
const ROW_HEIGHT = 20;

/** Above this many rows the review is windowed; a short one is cheaper, and steadier, drawn whole. */
const VIRTUALIZE_ABOVE = 200;

export type DiffPanelProps = DiffPickerActions & {
  diff: DiffState;
  workspaceId?: string;
  currentBranch?: string | null;
  onSetRange: (range: DiffRange) => void;
  onSetCollapsed: (path: string, collapsed: boolean) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
  onSetSplit: (split: boolean) => void;
  onSetIgnoreWhitespace: (ignore: boolean) => void;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
  annotations: Annotation[];
  /** A selected range and the note taken on it, which becomes a pill in the composer. */
  onComment: (quote: string, note: string, anchor: AnnotationAnchor) => void;
  onEditComment: (annotationId: string, note: string) => void;
  onRemoveComment: (annotationId: string) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  /** The find bar, when it is this review being searched. The bar itself is drawn by the dock. */
  find?: FindView | null;
  onFindResults?: (results: FindResults) => void;
};

function summaryMessage(result: DiffSummaryResult | null, loading: boolean, workspaceId: string | undefined, ignoreWhitespace: boolean) {
  if (!workspaceId) return "Open a project to review changes";
  /** A first read has nothing to draw, so one quiet line says why the list is not there yet. */
  if (!result) return loading ? "Reading the comparison…" : null;
  if (result.status === "error") return result.message;
  if (result.status === "unknown") return "Workspace is no longer registered";
  if (result.status === "unavailable") return `Workspace is ${result.reason}`;
  if (result.files.length > 0) return null;
  /** An empty review is worth one more line when a setting is what emptied it. */
  return ignoreWhitespace
    ? "Nothing has changed in this comparison. Lines that only changed spacing are hidden."
    : "Nothing has changed in this comparison";
}

/** Whether the review still holds a file that opened folded because it is too large to draw. */
function overDrawingBudget(files: DiffFileSummary[], collapsed: Set<string>) {
  return [...foldedForSize(files)].some((path) => collapsed.has(path));
}

/** The one line above the list: why it is not there, what it waits for, or why it opened folded. */
function panelNote(panel: {
  result: DiffSummaryResult | null;
  loading: boolean;
  workspaceId: string | undefined;
  settling: boolean;
  overBudget: boolean;
  ignoreWhitespace: boolean;
}) {
  const message = summaryMessage(panel.result, panel.loading, panel.workspaceId, panel.ignoreWhitespace);
  if (message) return message;
  if (panel.settling) return "Reading the changes…";
  if (panel.overBudget) return "This review is large, so its biggest files start folded.";
  return null;
}

/** What the review adds up to: how much of it the user has ticked off, and what it costs in lines. */
function ReviewProgress({ files, viewed, additions, deletions }: {
  files: DiffFileSummary[];
  viewed: Record<string, string>;
  additions: number;
  deletions: number;
}) {
  if (files.length === 0) return null;
  return (
    <p className="diff-progress">
      <span>{files.filter((file) => viewed[file.path]).length} of {files.length} viewed</span>
      <span className="change-counts"><strong>+{additions}</strong><em>−{deletions}</em></span>
    </p>
  );
}

/**
 * What a row is handed to act on, held at one identity: the panel is drawn again by anything the
 * window does, and a row whose props have not moved is left alone rather than reconciled line by line.
 */
function useRowHandlers(
  onSetCollapsed: (path: string, collapsed: boolean) => void,
  onOpenFile: (path: string) => void,
  onSetViewed: (path: string, viewed: boolean) => void,
) {
  const handlers = useRef({ onSetCollapsed, onOpenFile, onSetViewed });
  handlers.current = { onSetCollapsed, onOpenFile, onSetViewed };
  return {
    onSetCollapsed: useCallback((path: string, fold: boolean) => handlers.current.onSetCollapsed(path, fold), []),
    onOpenFile: useCallback((path: string) => handlers.current.onOpenFile(path), []),
    onSetViewed: useCallback((path: string, tick: boolean) => handlers.current.onSetViewed(path, tick), []),
  };
}

export function DiffPanel({
  diff,
  workspaceId,
  currentBranch,
  onSetCollapsed,
  onSetViewed,
  onSetSplit,
  onSetIgnoreWhitespace,
  onRefresh,
  onOpenFile,
  annotations,
  onComment,
  onEditComment,
  onRemoveComment,
  openMenu,
  onSetOpenMenu,
  find = null,
  onFindResults,
  ...comparisonActions
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
  const roomForTwo = useRoomForTwo(panelRef);
  const split = diff.split && roomForTwo;

  const readAll = useReadWholeReview(`${workspaceId ?? ""}|${rangeKey(diff.range)}|${diff.ignoreWhitespace}`, find?.query);
  const { drawn, settling, notes, patches, versionOf, patchOf, noteFor } = useDrawnFiles(workspaceId, diff.range, diff.ignoreWhitespace, files, collapsed, readAll);
  const span = useSelectionSpan(selection, drawn);

  /** Draft comments only mark the exact comparison and rows they were made from. */
  const diffComments = useMemo(() => anchoredDiffComments(annotations, rangeKey(diff.range), drawn), [annotations, diff.range, drawn]);
  const commentRows = useMemo(() => indexDiffComments(diffComments), [diffComments]);

  const rows = usePanelRows({ files, collapsed, drawn, settling, notes, split, span, selectionPath: selection?.path, noteFor });

  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 24,
    initialRect: { width: 420, height: 720 },
  });

  const setViewed = useTickThrough({
    scroller: scrollRef, rows, windowed, virtualizer, files, viewed: diff.viewed, searching: Boolean(find?.query), onSetViewed,
  });
  const { pinned, sync: syncPinned } = usePinnedFile(scrollRef, rows, files, windowed, virtualizer);

  /** A colouring pass fills its tokens in place, so the rows are handed a new map to read them from. */
  const painted = useLazyColours(rows.length, windowed ? virtualizer : null, (index) => colourRow(rows[index], drawn));
  const coloured = useMemo(() => new Map(drawn), [drawn, painted]);

  useReviewFind({
    find, files, versionOf, patchOf, patches, rows, collapsed, windowed, virtualizer, scrollRef, onSetCollapsed,
    onResults: onFindResults ?? (() => undefined),
  });

  /** The caret goes to the note when a run is first picked, and stays wherever the user puts it after. */
  useEffect(() => {
    if (selection) noteRef.current?.focus();
  }, [selection?.path, selection?.anchor]);

  /** A comparison that changes is a different set of lines, so a range picked in the last one is gone. */
  useEffect(() => { setSelection(null); setNote(""); setEditing(null); }, [diff.range, diff.mode, workspaceId]);
  const quote = selection && span?.rows.length ? commentQuote(selection.path, span.rows, selectionSide(span.rows)) : null;

  const selectByKey = useCallback((path: string, key: string, extend: boolean) => {
    if (editing) setNote("");
    setEditing(null);
    setSelection((current) => extend && current?.path === path ? { ...current, head: key } : { path, anchor: key, head: key });
  }, [editing]);
  const selected = useMemo(() => selection && span ? { path: selection.path, from: span.from, to: span.to } : null, [selection, span]);
  const clear = () => { setSelection(null); setNote(""); setEditing(null); };

  const comment = () => {
    if (!quote || !selection || !span) return;
    if (editing) onEditComment(editing, note.trim());
    else onComment(quote, note.trim(), diffAnchor(diff.range, selection, span.rows));
    clear();
  };

  const editComment = useCallback((comment: DiffComment) => {
    const anchor = comment.annotation.anchor;
    if (anchor?.kind !== "diff") return;
    setSelection({ path: anchor.path, anchor: anchor.start, head: anchor.end });
    setNote(comment.annotation.note);
    setEditing(comment.annotation.id);
  }, []);

  const removeComment = () => {
    if (editing) onRemoveComment(editing);
    clear();
  };

  const rowHandlers = useRowHandlers(onSetCollapsed, onOpenFile, setViewed);
  const rowView = {
    collapsed,
    viewed: diff.viewed,
    drawn: coloured,
    comments: commentRows,
    selected,
    onSelect: selectByKey,
    onEditComment: editComment,
    ...rowHandlers,
  };

  /** The composer is drawn where the review picked it up, and is the one row that is never held still. */
  const drawRow = (row: PanelRow) => row.kind === "composer"
    ? <DiffCommentEditor quote={quote} note={note} editing={editing !== null} noteRef={noteRef} onNote={setNote} onSubmit={comment} onClear={clear} onRemove={removeComment} />
    : <PanelRowView row={row} {...rowView} />;

  const overBudget = useMemo(() => overDrawingBudget(files, collapsed), [files, collapsed]);
  const notice = panelNote({ result: diff.result, loading: diff.loading, workspaceId, settling, overBudget, ignoreWhitespace: diff.ignoreWhitespace });

  return (
    <section className="diff-panel" aria-label="Changes" ref={panelRef}>
      <DiffToolbar
        {...comparisonActions}
        diff={diff}
        split={split}
        roomForTwo={roomForTwo}
        currentBranch={currentBranch}
        {...(workspaceId ? { workspaceId } : {})}
        openMenu={openMenu}
        onSetOpenMenu={onSetOpenMenu}
        onToggleSplit={() => onSetSplit(!diff.split)}
        onToggleWhitespace={() => onSetIgnoreWhitespace(!diff.ignoreWhitespace)}
        onRefresh={onRefresh}
      />

      {available && <ReviewProgress files={files} viewed={diff.viewed} additions={available.additions} deletions={available.deletions} />}
      {notice && <p className="session-note">{notice}</p>}

      <div className="diff-scroll">
        <div className="diff-files" ref={scrollRef} onScroll={syncPinned} aria-label="Changed files">
          {!windowed && rows.map((row) => <div key={row.key}>{drawRow(row)}</div>)}
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
                  {drawRow(rows[item.index])}
                </div>
              ) : null)}
            </div>
          )}
        </div>
        {pinned && <PinnedFileRow file={pinned} open={!collapsed.has(pinned.path)} viewed={Boolean(diff.viewed[pinned.path])} onToggle={onSetCollapsed} onOpenFile={onOpenFile} onSetViewed={setViewed} />}
      </div>

    </section>
  );
}
