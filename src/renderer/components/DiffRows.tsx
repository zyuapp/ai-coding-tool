import type { ComponentProps } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { DiffFileSummary, DiffLineKind, DiffRow, DiffSide } from "../../domain/diff";
import type { DiffComment, DiffCommentIndex, DrawnFile, PanelRow } from "../diff/panel-rows";
import type { ThemedToken } from "../diff/highlight";
import { FileHeader } from "./DiffFileRow";
import { DiffCommentEditor } from "./DiffCommentEditor";

/** What a row's text becomes once a grammar has read the block it came from. */
function RowText({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens) return <>{text || " "}</>;
  return <>{tokens.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content}</span>)}</>;
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

/** The numbered marks a commented row carries, each of which opens the note again. */
function CommentMarkers({ row, comments, onEditComment }: {
  row: Extract<DiffRow, { kind: DiffLineKind }>;
  comments: DiffComment[];
  onEditComment: (comment: DiffComment) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <span className="diff-inline-comment-markers">
      {comments.map((comment) => (
        <button
          key={comment.annotation.id}
          type="button"
          aria-label={`Edit comment ${comment.number} on ${rowLabel(row).toLowerCase()}`}
          data-tip="Read or edit this comment"
          onClick={() => onEditComment(comment)}
        >
          {comment.number}
        </button>
      ))}
    </span>
  );
}

type LineRowProps = {
  path: string;
  row: DiffRow;
  tokens: Map<string, ThemedToken[]>;
  selected: boolean;
  commented: boolean;
  comments: DiffComment[];
  onSelect: (extend: boolean) => void;
  onEditComment: (comment: DiffComment) => void;
};

/** One line of the one-column view. Its gutter is the only thing that selects, the way a review reads. */
function LineRow({ path, row, tokens, selected, commented, comments, onSelect, onEditComment }: LineRowProps) {
  if (row.kind === "hunk") return <div className="diff-line hunk">{row.text}</div>;
  return (
    <div className={`diff-line ${row.kind}${commented ? " commented" : ""}${selected ? " selected" : ""}`}>
      <CommentMarkers row={row} comments={comments} onEditComment={onEditComment} />
      <button
        className="diff-gutter"
        type="button"
        aria-label={`Add comment on ${rowLabel(row).toLowerCase()}`}
        data-tip="Add a comment. Shift-click to take in a range of lines."
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <i className="diff-comment-affordance" aria-hidden="true"><MessageSquarePlus size={12} /></i>
        <span>{row.oldLine ?? ""}</span>
        <span>{row.newLine ?? ""}</span>
      </button>
      <span className="diff-marker" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "}</span>
      <code data-find-row={`${path}\n${row.key}`}><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

type SplitCellProps = {
  path: string;
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
function SplitCell({ path, row, tokens, side, selected, commented, comments, onSelect, onEditComment }: SplitCellProps) {
  if (!row || row.kind === "hunk") return <div className="diff-split-cell empty" />;
  return (
    <div className={`diff-split-cell ${row.kind}${commented ? " commented" : ""}${selected ? " selected" : ""}`}>
      <CommentMarkers row={row} comments={comments} onEditComment={onEditComment} />
      <button
        className="diff-gutter static"
        type="button"
        aria-label={`Add comment on ${rowLabel(row).toLowerCase()}`}
        data-tip="Add a comment. Shift-click to take in a range of lines."
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <i className="diff-comment-affordance" aria-hidden="true"><MessageSquarePlus size={12} /></i>
        <span>{side === "old" ? row.oldLine ?? "" : row.newLine ?? ""}</span>
      </button>
      <code data-find-row={`${path}\n${row.key}`}><RowText text={row.text} tokens={tokens.get(row.key)} /></code>
    </div>
  );
}

type SplitPairRowProps = {
  path: string;
  left: DiffRow | null;
  right: DiffRow | null;
  tokens: Map<string, ThemedToken[]>;
  indexByKey: Map<string, number> | undefined;
  comments: DiffCommentIndex;
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
        path={path}
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
        path={path}
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
export function PinnedFileRow({ file, open, viewed, onToggle, onOpenFile, onSetViewed }: {
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

export type PanelRowViewProps = {
  row: PanelRow;
  collapsed: Set<string>;
  viewed: Record<string, string>;
  drawn: Map<string, DrawnFile>;
  comments: DiffCommentIndex;
  /** The note being written, wherever in the review the run it is about was drawn. */
  composer: ComponentProps<typeof DiffCommentEditor>;
  isSelected: (path: string, index: number | undefined) => boolean;
  onSelect: (path: string, key: string, extend: boolean) => void;
  onEditComment: (comment: DiffComment) => void;
  onSetCollapsed: (path: string, collapsed: boolean) => void;
  onOpenFile: (path: string) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
};

const EMPTY_TOKENS = new Map<string, ThemedToken[]>();

/** One panel row, drawn the same whether the review is windowed or laid out whole. */
export function PanelRowView({
  row,
  collapsed,
  viewed,
  drawn,
  comments,
  composer,
  isSelected,
  onSelect,
  onEditComment,
  onSetCollapsed,
  onOpenFile,
  onSetViewed,
}: PanelRowViewProps) {
  if (row.kind === "file") {
    return (
      <FileHeader
        file={row.file}
        open={!collapsed.has(row.file.path)}
        viewed={Boolean(viewed[row.file.path])}
        onToggle={() => onSetCollapsed(row.file.path, !collapsed.has(row.file.path))}
        onOpenFile={onOpenFile}
        onSetViewed={onSetViewed}
      />
    );
  }
  if (row.kind === "note") return <p className="diff-note">{row.text}</p>;
  if (row.kind === "composer") return <DiffCommentEditor {...composer} />;
  const tokens = drawn.get(row.path)?.colours.tokens ?? EMPTY_TOKENS;
  if (row.kind === "line") {
    const key = `${row.path}\n${row.index}`;
    return (
      <LineRow
        path={row.path}
        row={row.row}
        tokens={tokens}
        selected={isSelected(row.path, row.index)}
        commented={comments.highlighted.has(key)}
        comments={comments.markers.get(key) ?? []}
        onSelect={(extend) => onSelect(row.path, row.row.key, extend)}
        onEditComment={onEditComment}
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
      comments={comments}
      isSelected={isSelected}
      onSelect={(key, extend) => onSelect(row.path, key, extend)}
      onEditComment={onEditComment}
    />
  );
}
