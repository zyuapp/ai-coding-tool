import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { fileFingerprint, type DiffFileSummary, type DiffRange } from "../../domain/diff";
import { usePatches, type PatchRequest } from "./use-patch";
import {
  buildPanelRows,
  drawFile,
  patchNote,
  spanOf,
  type DrawnFile,
  type PanelRow,
  type PanelRowsInput,
  type Selection,
} from "./panel-rows";

/**
 * Two columns need room for two. The dock opens wider than this, so a review is side by side unless
 * the user has narrowed it; below here each side is down to a few words a line and one column reads
 * better, so the review falls back whatever the thread last chose.
 */
const SPLIT_MIN_WIDTH = 520;

/** Whether the panel is wide enough to be read in two columns. */
export function useRoomForTwo(panel: RefObject<HTMLElement | null>) {
  const [roomForTwo, setRoomForTwo] = useState(true);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    /** A panel that has not been laid out yet measures zero, which is no answer rather than "too narrow". */
    const measure = () => setRoomForTwo((width) => element.clientWidth === 0 ? width : element.clientWidth >= SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return roomForTwo;
}

/** What reading one file's patch is asked for by, keyed so a file rewritten under the user is read again. */
function requestsFor(files: DiffFileSummary[]): PatchRequest[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    version: `${file.path}|${fileFingerprint(file)}`,
  }));
}

/**
 * Every open file's patch, parsed and tokenized, and whether the list is still waiting for its first.
 * `readAll` asks for the folded files' patches too, which is what a search over the whole review needs.
 */
export function useDrawnFiles(
  workspaceId: string | undefined,
  range: DiffRange,
  ignoreWhitespace: boolean,
  files: DiffFileSummary[],
  collapsed: Set<string>,
  readAll: boolean,
) {
  /** Only the files that are open and have lines in them are worth drawing. */
  const requests = useMemo(() => requestsFor(files.filter((file) => !file.binary && !collapsed.has(file.path))), [files, collapsed]);
  /**
   * What is read, which is either the open files or all of them. Never the two spliced together:
   * the reads are keyed by this list, so one that shifted whenever a file was folded would cancel
   * every read still in flight.
   */
  const everything = useMemo(() => requestsFor(files.filter((file) => !file.binary)), [files]);
  const { patches, at } = usePatches(workspaceId, range, ignoreWhitespace, readAll ? everything : requests);

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
  const published = useRef(new Map<string, DrawnFile>());
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
    /**
     * The same map again when nothing under it moved. A search reads the folded files too, and each
     * of those landing changes nothing that is drawn: without this every one of them would rebuild
     * the whole row list, which on a long review is the one cost that would be felt.
     */
    const settled = published.current.size === built.size && [...built].every(([path, drawing]) => published.current.get(path) === drawing);
    if (settled) return published.current;
    published.current = built;
    return built;
    // `at` reads `patches`, which is a fresh map whenever one has landed.
  }, [requests, patches]);

  /**
   * What the notes under the open files say. Rows are rebuilt on this rather than on every patch that
   * lands, so a file being read for a search never redraws a review it is not drawn in.
   */
  const notes = useMemo(
    () => requests.map((request) => `${request.path}:${patchNote(at(request.version)) ?? ""}`).join("\n"),
    // `at` reads `patches`, which is a fresh map whenever one has landed.
    [requests, patches],
  );

  /** Where one file's patch has got to: unasked for, being read, read, or more than can be shown. */
  const patchOf = (path: string) => at(versionOf.get(path) ?? "");

  return { drawn, settling, notes, patches, versionOf, patchOf, noteFor: (path: string) => patchNote(patchOf(path)) };
}

export function useSelectionSpan(selection: Selection | null, drawn: Map<string, DrawnFile>) {
  return useMemo(() => spanOf(selection, drawn), [selection, drawn]);
}

/** Every drawn line of the review, rebuilt only when something under it has moved. */
export function usePanelRows(input: PanelRowsInput & { notes: string }) {
  const { files, collapsed, drawn, settling, split, span, selectionPath, notes } = input;
  return useMemo(
    () => buildPanelRows(input),
    [settling, files, collapsed, drawn, notes, split, span, selectionPath],
  );
}

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

/**
 * The file the top edge of the review is inside, and the way to look again. Its row is drawn a
 * second time over the review, so the path stays readable however far into a long file the user
 * has scrolled.
 */
export function usePinnedFile(
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
