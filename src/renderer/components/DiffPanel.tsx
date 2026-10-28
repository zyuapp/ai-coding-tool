import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LuArrowDown as ArrowDown } from "react-icons/lu";
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
  if (result.status === "error") return loading ? "Reading the comparison…" : result.message;
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

/** Whether the line above the list is a failure the user can try again, rather than a wait or a fact. */
function failed(result: DiffSummaryResult | null) {
  return result?.status === "error";
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

/** The line above the list, with a retry when it reports a failure. */
function PanelNotice({ notice, failed, onRetry }: { notice: string; failed: boolean; onRetry: () => void }) {
  return failed
    ? <p className="diff-error" role="alert"><span>{notice}</span><button type="button" onClick={onRetry}>Try again</button></p>
    : <p className="session-note">{notice}</p>;
}

/** What the review adds up to: how much of it the user has ticked off, and what it costs in lines. */
function ReviewProgress({ files, viewed, additions, deletions, onNext }: {
  files: DiffFileSummary[];
  viewed: Record<string, string>;
  additions: number;
  deletions: number;
  onNext: () => void;
}) {
  if (files.length === 0) return null;
  const done = files.filter((file) => viewed[file.path]).length;
  const label = `${done} of ${files.length} viewed`;
  return (
    <div className="diff-progress">
      {done < files.length
        ? <button type="button" aria-keyshortcuts="N" data-tip="Next unviewed file (N)" onClick={onNext}>{label}<ArrowDown size={12} aria-hidden="true" /></button>
        : <span>{label}</span>}
      <span className="change-counts"><strong>+{additions}</strong><em>−{deletions}</em></span>
      <span className="diff-progress-meter" aria-hidden="true"><span style={{ width: `${(done / files.length) * 100}%` }} /></span>
    </div>
  );
}

function typing(target: EventTarget) {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input:not([type=checkbox]), textarea, select"));
}

function gutterOf(target: EventTarget | null) {
  const gutter = target instanceof Element ? target.closest<HTMLElement>(".diff-gutter") : null;
  return gutter?.dataset.key ? gutter : null;
}

/** The file row or gutter above or below, keeping to the column a two-column gutter is in. */
function reviewStep(root: HTMLElement, from: HTMLElement, step: 1 | -1) {
  const cell = from.closest(".diff-split-cell");
  const column = cell?.matches(":first-child") ? ":first-child" : ":last-child";
  const stops = [...root.querySelectorAll<HTMLElement>(".diff-file-open, .diff-gutter")].filter((stop) => {
    const own = stop.closest(".diff-split-cell");
    return !cell || !own || own.matches(column);
  });
  return stops[stops.indexOf(from) + step] ?? null;
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

/** Picks diff lines by gutter click, drag, or Shift+Arrow, and walks file rows and gutters from the keyboard. */
function useLinePicking({ editing, setNote, setEditing, setSelection, noteRef }: {
  editing: string | null;
  setNote: (note: string) => void;
  setEditing: (id: string | null) => void;
  setSelection: Dispatch<SetStateAction<Selection | null>>;
  noteRef: RefObject<HTMLTextAreaElement | null>;
}) {
  /** A drag down the gutter is still picking lines, so the note waits below until it lets go. */
  const [dragging, setDragging] = useState(false);
  const dragPath = useRef<string | null>(null);
  /** Lines picked from the keyboard keep the keyboard in the gutter, so the run can keep growing. */
  const keepGutterFocus = useRef(false);

  const selectByKey = useCallback((path: string, key: string, extend: boolean, fromKeys = false) => {
    keepGutterFocus.current = fromKeys;
    if (editing) setNote("");
    setEditing(null);
    setSelection((current) => {
      if (!extend || current?.path !== path) return { path, anchor: key, head: key };
      return current.head === key ? current : { ...current, head: key };
    });
  }, [editing]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    const gutter = gutterOf(event.target);
    if (!gutter) return;
    event.preventDefault();
    selectByKey(gutter.dataset.path!, gutter.dataset.key!, event.shiftKey);
    if (event.shiftKey) return;
    dragPath.current = gutter.dataset.path!;
    setDragging(true);
    const end = () => {
      dragPath.current = null;
      setDragging(false);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const dragOver = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragPath.current) return;
    const line = event.target instanceof Element ? event.target.closest(".diff-line, .diff-split-cell") : null;
    const gutter = line?.querySelector<HTMLElement>(".diff-gutter");
    if (gutter?.dataset.key && gutter.dataset.path === dragPath.current) selectByKey(dragPath.current, gutter.dataset.key, true);
  };

  /** Up and Down walk the file rows and gutters; with Shift they pick lines; Enter on a picked line goes to its note. */
  const reviewKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = event.target as HTMLElement;
    if (event.key === "Enter" && at.matches(".diff-gutter") && at.closest(".selected")) {
      event.preventDefault();
      keepGutterFocus.current = false;
      noteRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!at.matches(".diff-gutter, .diff-file-open")) return;
    const next = reviewStep(event.currentTarget, at, event.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    event.preventDefault();
    if (event.shiftKey && at.matches(".diff-gutter") && next.matches(".diff-gutter") && next.dataset.path === at.dataset.path) {
      if (!at.closest(".selected")) selectByKey(at.dataset.path!, at.dataset.key!, false, true);
      selectByKey(next.dataset.path!, next.dataset.key!, true, true);
    }
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };
  return { selectByKey, dragging, keepGutterFocus, startDrag, dragOver, reviewKeys };
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

  const { selectByKey, dragging, keepGutterFocus, startDrag, dragOver, reviewKeys } = useLinePicking({ editing, setNote, setEditing, setSelection, noteRef });
  const rows = usePanelRows({ files, collapsed, drawn, settling, notes, split, span: dragging ? null : span, selectionPath: selection?.path, noteFor });

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

  /** A colouring pass fills its tokens in place, so each file's paint count is what sends its rows back to read them. */
  const paints = useLazyColours(rows.length, windowed ? virtualizer : null, (index) => colourRow(rows[index], drawn));

  useReviewFind({
    find, files, versionOf, patchOf, patches, rows, collapsed, windowed, virtualizer, scrollRef, onSetCollapsed,
    onResults: onFindResults ?? (() => undefined),
  });

  /** The caret goes to the note when a run is first picked, and stays wherever the user puts it after. */
  useEffect(() => {
    if (selection && !dragging && !keepGutterFocus.current) noteRef.current?.focus();
  }, [selection?.path, selection?.anchor, dragging]);

  /** A comparison that changes is a different set of lines, so a range picked in the last one is gone. */
  useEffect(() => { setSelection(null); setNote(""); setEditing(null); }, [diff.range, diff.mode, workspaceId]);
  const quote = selection && span?.rows.length ? commentQuote(selection.path, span.rows, selectionSide(span.rows)) : null;

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
    comments: commentRows,
    selected,
    onSelect: selectByKey,
    onEditComment: editComment,
    ...rowHandlers,
  };

  /** The composer is drawn where the review picked it up, and is the one row that is never held still. */
  const drawRow = (row: PanelRow) => row.kind === "composer"
    ? <DiffCommentEditor quote={quote} note={note} editing={editing !== null} noteRef={noteRef} onNote={setNote} onSubmit={comment} onClear={clear} onRemove={removeComment} />
    : <PanelRowView row={row} drawing={drawn.get(row.path)} paint={paints.get(row.path) ?? 0} {...rowView} />;

  /** The first file still to read after the one being read, wrapping to the top of the review. */
  const nextUnviewed = () => {
    const from = pinned ? files.findIndex((file) => file.path === pinned.path) : -1;
    const next = [...files.slice(from + 1), ...files.slice(0, from + 1)].find((file) => !diff.viewed[file.path]);
    if (!next) return;
    if (collapsed.has(next.path)) onSetCollapsed(next.path, false);
    const index = rows.findIndex((row) => row.kind === "file" && row.path === next.path);
    if (index === -1) return;
    if (windowed) virtualizer.scrollToIndex(index, { align: "start" });
    else (scrollRef.current?.children[index] as HTMLElement | undefined)?.scrollIntoView({ block: "start" });
  };

  const overBudget = useMemo(() => overDrawingBudget(files, collapsed), [files, collapsed]);
  const notice = panelNote({ result: diff.result, loading: diff.loading, workspaceId, settling, overBudget, ignoreWhitespace: diff.ignoreWhitespace });

  return (
    <section className="diff-panel" aria-label="Changes" ref={panelRef} onKeyDown={(event) => {
      if (event.key !== "n" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      nextUnviewed();
    }}>
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

      {available && <ReviewProgress files={files} viewed={diff.viewed} additions={available.additions} deletions={available.deletions} onNext={nextUnviewed} />}
      {notice && <PanelNotice notice={notice} failed={failed(diff.result) && !diff.loading} onRetry={onRefresh} />}

      <div className="diff-scroll">
        <div className="diff-files" ref={scrollRef} onScroll={syncPinned} onPointerDown={startDrag} onPointerOver={dragOver} onKeyDown={reviewKeys} aria-label="Changed files">
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
