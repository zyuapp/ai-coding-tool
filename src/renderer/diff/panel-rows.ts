import type { Annotation, AnnotationAnchor } from "../../domain/conversation";
import {
  commentQuote,
  diffRows,
  lineOn,
  rangeKey,
  splitRows,
  type DiffFile,
  type DiffFileSummary,
  type DiffRange,
  type DiffRow,
  type DiffSide,
  type SplitRow,
} from "../../domain/diff";
import { fileTokens, type FileTokens } from "./highlight";
import type { PatchState } from "./use-patch";

/** Why a file can be in the list and still have no lines under it. */
export function emptyPatchNote(file: DiffFileSummary) {
  if (file.additions === 0 && file.deletions === 0) return "No changes to the file's contents";
  return "Nothing to show for this comparison";
}

/** What a patch that is not lines to read has to say instead. */
export function patchNote(patch: PatchState | undefined) {
  if (!patch || patch.status === "reading") return "Reading the patch…";
  if (patch.status === "error") return patch.message;
  if (patch.status === "too-large") return `Patch is larger than ${Math.round(patch.limit / 1_000_000)} MB. Open it in your editor.`;
  return null;
}

/** Which side a selection names: the old one only when every line in it was taken away. */
export function selectionSide(rows: DiffRow[]): DiffSide {
  const lines = rows.filter((row) => row.kind !== "hunk");
  return lines.length > 0 && lines.every((row) => row.kind === "delete") ? "old" : "new";
}

/**
 * One file's patch as everything drawing it needs: the rows in one column and in two, the tokens they
 * are coloured with, and where each row sits in the one order a selection is measured in.
 */
export type DrawnFile = {
  rows: DiffRow[];
  pairs: SplitRow[];
  colours: FileTokens;
  indexByKey: Map<string, number>;
};

export type DiffComment = {
  annotation: Annotation;
  number: number;
  path: string;
  from: number;
  to: number;
  marker: number;
  side: DiffSide;
};

export function drawFile(file: DiffFile): DrawnFile {
  const rows = diffRows(file);
  return {
    rows,
    pairs: splitRows(file),
    colours: fileTokens(file),
    indexByKey: new Map(rows.map((row, index) => [row.key, index])),
  };
}

export function anchoredDiffComments(annotations: Annotation[], comparison: string, drawn: Map<string, DrawnFile>) {
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

export function indexDiffComments(comments: DiffComment[]) {
  const highlighted = new Set<string>();
  const markers = new Map<string, DiffComment[]>();
  for (const comment of comments) {
    for (let index = comment.from; index <= comment.to; index += 1) highlighted.add(`${comment.path}\n${index}`);
    const key = `${comment.path}\n${comment.marker}`;
    markers.set(key, [...(markers.get(key) ?? []), comment]);
  }
  return { highlighted, markers };
}

export type DiffCommentIndex = ReturnType<typeof indexDiffComments>;

export function diffAnchor(range: DiffRange, selection: Selection, rows: DiffRow[]): AnnotationAnchor {
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
export type Selection = { path: string; anchor: string; head: string };

/** The run a selection covers right now, in the one order the rows of a file are measured in. */
export type DiffSpan = { rows: DiffRow[]; from: number; to: number };

/**
 * The rows a selection covers right now. Both ends have to still be in the file, and a hunk header
 * between them ends the run: a range that jumps a header would quote lines the user never saw.
 */
export function spanOf(selection: Selection | null, drawn: Map<string, DrawnFile>): DiffSpan | null {
  if (!selection) return null;
  const drawing = drawn.get(selection.path);
  const from = drawing?.indexByKey.get(selection.anchor);
  const to = drawing?.indexByKey.get(selection.head);
  if (!drawing || from === undefined || to === undefined) return null;
  const rows = drawing.rows.slice(Math.min(from, to), Math.max(from, to) + 1);
  return rows.some((row) => row.kind === "hunk") ? null : { rows, from: Math.min(from, to), to: Math.max(from, to) };
}

/**
 * Every drawn line of the panel, flat, so one window covers the whole review rather than each file.
 * Every row names the file it belongs to, which is what the pinned header reads off the top edge.
 */
export type PanelRow =
  | { kind: "file"; key: string; path: string; file: DiffFileSummary }
  | { kind: "note"; key: string; path: string; text: string }
  | { kind: "line"; key: string; path: string; row: DiffRow; index: number }
  | { kind: "pair"; key: string; path: string; row: SplitRow }
  /** The note being written, drawn under the run it is about rather than docked away from it. */
  | { kind: "composer"; key: string; path: string };

/** The rows a drawn line stands for: one in a single column, and either side of a pair in two. */
export function colouredKeys(row: PanelRow): string[] {
  if (row.kind === "line") return [row.row.key];
  if (row.kind !== "pair" || row.row.kind !== "pair") return [];
  return [row.row.left?.key, row.row.right?.key].filter((key): key is string => key !== undefined);
}

/** Colour follows the drawing: a row is read when it is on screen, not when its patch arrives. */
export function colourRow(row: PanelRow | undefined, drawn: Map<string, DrawnFile>) {
  const colours = row ? drawn.get(row.path)?.colours : undefined;
  if (!row || !colours) return false;
  let drew = false;
  for (const key of colouredKeys(row)) {
    const hunk = colours.hunkOf.get(key);
    if (hunk !== undefined && colours.colour(hunk)) drew = true;
  }
  return drew;
}

export type PanelRowsInput = {
  files: DiffFileSummary[];
  collapsed: Set<string>;
  drawn: Map<string, DrawnFile>;
  /** Whether the list is still waiting for its first patch, which is the hold on drawing anything. */
  settling: boolean;
  split: boolean;
  span: DiffSpan | null;
  selectionPath: string | undefined;
  noteFor: (path: string) => string | null;
};

export function buildPanelRows({ files, collapsed, drawn, settling, split, span, selectionPath, noteFor }: PanelRowsInput) {
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
      panel.push({ kind: "note", key: `n:${file.path}`, path: file.path, text: noteFor(file.path) ?? "Reading the patch…" });
      continue;
    }
    /** The composer follows the last drawn row of the selection, whichever view drew it. */
    const commenting = span && selectionPath === file.path;
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
}
