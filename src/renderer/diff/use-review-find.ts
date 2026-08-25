/**
 * Searching a review. Most of a large comparison is never drawn — the list is windowed, and a folded
 * file has no rows at all — so the search reads the row data rather than the screen, and the screen
 * is only ever lit with what the data already counted.
 *
 * It answers in two passes. The names and the patches already read are counted on the keystroke; the
 * rest arrive as `useDrawnFiles` reads them, and each one folds into the total where its file sits.
 * The total therefore only ever grows, and stepping works on whatever has been counted so far.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { DiffFileSummary } from "../../domain/diff";
import { MAX_FIND_HITS, reviewHits, sameReviewHit, targetKey, type FindResults, type ReviewFile, type ReviewHit } from "../../domain/find";
import type { FindView } from "../../application/workspace-state";
import { drawnMatches, paintMatches } from "../find/paint";
import { colouredKeys, type PanelRow } from "./panel-rows";
import type { PatchState } from "./use-patch";

/** How long a search waits before it asks for the folded files, so typing costs nothing to read. */
const READ_ALL_AFTER = 200;

/**
 * Whether every file's patch is wanted rather than only the open ones. A search reaches past what is
 * drawn, so it latches once one is under way and stays latched for the life of the comparison: folding
 * a file no longer throws its lines away, and searching again costs nothing.
 */
export function useReadWholeReview(comparison: string, query: string | undefined): boolean {
  const [readAll, setReadAll] = useState(false);
  useEffect(() => setReadAll(false), [comparison]);
  useEffect(() => {
    if (readAll || !query?.trim()) return;
    const timer = window.setTimeout(() => setReadAll(true), READ_ALL_AFTER);
    return () => window.clearTimeout(timer);
  }, [readAll, query]);
  return readAll;
}

/** How a hit names the row that draws it, which is also what that row is marked with on screen. */
function rowKeyOf(hit: ReviewHit): string {
  return `${hit.path}\n${hit.key ?? ""}`;
}

export type ReviewFindInput = {
  /** The bar, when it is this review being searched. */
  find: FindView | null;
  files: DiffFileSummary[];
  versionOf: Map<string, string>;
  patchOf: (path: string) => PatchState | undefined;
  /** A fresh map whenever a patch has landed, which is what the count is folded again on. */
  patches: Map<string, PatchState>;
  rows: PanelRow[];
  collapsed: Set<string>;
  windowed: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSetCollapsed: (path: string, collapsed: boolean) => void;
  onResults: (results: FindResults) => void;
};

export function useReviewFind({
  find,
  files,
  versionOf,
  patchOf,
  patches,
  rows,
  collapsed,
  windowed,
  virtualizer,
  scrollRef,
  onSetCollapsed,
  onResults,
}: ReviewFindInput): void {
  const needle = find?.query.trim().toLowerCase() ?? "";
  const painter = find ? targetKey(find.target) : "";

  /**
   * Every file's matches under the version its patch was read at, so a patch landing late costs one
   * file's scan rather than the whole review's. A new query is a new set, so the old one is dropped.
   */
  const scanned = useRef(new Map<string, ReviewHit[]>());
  const scannedFor = useRef("");

  const { hits, counting } = useMemo(() => {
    if (scannedFor.current !== needle) {
      scanned.current = new Map();
      scannedFor.current = needle;
    }
    /** A patch that is too large to show, or that failed, is never coming: its file counts for its name alone. */
    const seen = files.map((file): ReviewFile => {
      const patch = file.binary ? undefined : patchOf(file.path);
      return {
        path: file.path,
        version: versionOf.get(file.path) ?? "",
        file: patch?.status === "available" ? patch.file : null,
        coming: !file.binary && (patch === undefined || patch.status === "reading"),
      };
    });
    return reviewHits(seen, needle, scanned.current);
    // `patchOf` reads `patches`, which is a fresh map whenever one has landed.
  }, [files, patches, needle]);

  /**
   * The match being read, held by identity: a folded file landing inserts matches above it, and the
   * user must not be moved onto a different row while they are reading this one. It is held under the
   * needle it was found with, because a new needle is a new search that starts at its first match.
   */
  const held = useRef<{ needle: string; hit: ReviewHit | null; index: number }>({ needle: "", hit: null, index: 0 });
  const report = useRef(onResults);
  report.current = onResults;

  useEffect(() => {
    if (!find) {
      held.current = { needle: "", hit: null, index: 0 };
      return;
    }
    const anchor = held.current.needle === needle && held.current.index === find.index ? held.current.hit : null;
    const moved = anchor ? hits.findIndex((hit) => sameReviewHit(hit, anchor)) : -1;
    const index = moved >= 0 ? moved : Math.min(find.index, Math.max(0, hits.length - 1));
    held.current = { needle, hit: hits[index] ?? null, index };
    report.current({
      matches: hits.length,
      ...(index === find.index ? {} : { index }),
      ...(counting ? { counting: true } : {}),
    });
  }, [hits, counting, find?.index, find?.query]);

  const searching = find !== null && needle !== "";
  const active = find && hits.length > 0 ? hits[Math.min(find.index, hits.length - 1)] ?? null : null;

  /**
   * Which drawn row holds each key, so a match in the data can be found in the list drawing it. A
   * review nobody is searching builds nothing: the rows rebuild on every patch that lands and every
   * row the pointer crosses, and indexing tens of thousands of them for no one would cost more than
   * drawing them.
   */
  const rowIndexOf = useMemo(() => {
    const index = new Map<string, number>();
    if (!searching) return index;
    rows.forEach((row, at) => {
      if (row.kind === "file") index.set(`${row.path}\n`, at);
      else for (const key of colouredKeys(row)) index.set(`${row.path}\n${key}`, at);
    });
    return index;
  }, [rows, searching]);

  /**
   * A match in a file the user folded shut is reached by opening it, and only when they step onto it:
   * folding is theirs to do, so opening it again on every rebuild would take the fold straight back
   * off — which is also what ticking the file viewed does.
   */
  useEffect(() => {
    if (active && active.key !== null && collapsed.has(active.path)) onSetCollapsed(active.path, false);
  }, [active?.path, active?.key, active?.occurrence]);

  /** The row a match names exists once its file is open, so this runs again when the rows rebuild. */
  useEffect(() => {
    const row = active ? rowIndexOf.get(rowKeyOf(active)) : undefined;
    if (row === undefined) return;
    if (windowed) virtualizer.scrollToIndex(row, { align: "center" });
    else (scrollRef.current?.children[row] as HTMLElement | undefined)?.scrollIntoView({ block: "center" });
  }, [active?.path, active?.key, active?.occurrence, rowIndexOf]);

  /** Painting follows the drawing: a row lights up when the window brings it on screen, not before. */
  const drawn = !searching ? "" : windowed ? virtualizer.getVirtualItems().map((item) => item.key).join(",") : String(rows.length);

  useEffect(() => {
    if (!find) return;
    const found = drawnMatches(scrollRef.current, needle, "data-find-row", MAX_FIND_HITS);
    const lit = active ? found.find((match) => match.owner === rowKeyOf(active) && match.occurrence === active.occurrence) : undefined;
    paintMatches(painter, found.map((match) => match.range), lit?.range ?? null);
  }, [painter, needle, active?.path, active?.key, active?.occurrence, drawn, rows]);

  useEffect(() => () => paintMatches(painter, [], null), [painter]);
}
