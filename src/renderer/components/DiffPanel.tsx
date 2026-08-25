import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffSummaryResult } from "../../contracts/ipc";
import type { DiffState } from "../../application/workspace-state";
import type { Annotation, AnnotationAnchor } from "../../domain/task";
import { commentQuote, rangeKey, type DiffRange } from "../../domain/diff";
import {
  anchoredDiffComments,
  colourRow,
  diffAnchor,
  indexDiffComments,
  selectionSide,
  type DiffComment,
  type Selection,
} from "../diff/panel-rows";
import { useDrawnFiles, usePanelRows, usePinnedFile, useRoomForTwo, useSelectionSpan } from "../diff/use-panel";
import { useLazyColours } from "../diff/use-colours";
import { DiffToolbar } from "./DiffToolbar";
import { PanelRowView, PinnedFileRow } from "./DiffRows";

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
  const roomForTwo = useRoomForTwo(panelRef);
  const split = diff.split && roomForTwo;

  const { drawn, settling, patches, noteFor } = useDrawnFiles(workspaceId, diff.range, files, collapsed);
  const span = useSelectionSpan(selection, drawn);

  /** Draft comments only mark the exact comparison and rows they were made from. */
  const diffComments = useMemo(() => anchoredDiffComments(annotations, rangeKey(diff.range), drawn), [annotations, diff.range, drawn]);
  const commentRows = useMemo(() => indexDiffComments(diffComments), [diffComments]);

  const rows = usePanelRows({ files, collapsed, drawn, settling, patches, split, span, selectionPath: selection?.path, noteFor });

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

  useLazyColours(rows.length, windowed ? virtualizer : null, (index) => colourRow(rows[index], drawn));

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

  const rowView = {
    collapsed,
    viewed: diff.viewed,
    drawn,
    comments: commentRows,
    composer: {
      quote,
      note,
      editing: editing !== null,
      noteRef,
      onNote: setNote,
      onSubmit: comment,
      onClear: clear,
      onRemove: () => {
        if (editing) onRemoveComment(editing);
        clear();
      },
    },
    isSelected,
    onSelect: selectByKey,
    onEditComment: editComment,
    onSetCollapsed,
    onOpenFile,
    onSetViewed,
  };

  const viewedCount = files.filter((file) => diff.viewed[file.path]).length;
  const message = summaryMessage(diff.result, diff.loading, workspaceId);

  return (
    <section className="diff-panel" aria-label="Changes" ref={panelRef}>
      <DiffToolbar
        range={diff.range}
        loading={diff.loading}
        split={split}
        roomForTwo={roomForTwo}
        {...(workspaceId ? { workspaceId } : {})}
        openMenu={openMenu}
        onSetOpenMenu={onSetOpenMenu}
        onSetRange={onSetRange}
        onToggleSplit={() => onSetSplit(!diff.split)}
        onRefresh={onRefresh}
      />

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
          {!windowed && rows.map((row) => <div key={row.key}><PanelRowView row={row} {...rowView} /></div>)}
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
                  <PanelRowView row={rows[item.index]} {...rowView} />
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
