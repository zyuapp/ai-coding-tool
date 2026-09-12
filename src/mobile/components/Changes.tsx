import { LuChevronDown as ChevronDown, LuChevronRight as ChevronRight, LuFileMinus2 as FileMinus2, LuFilePen as FilePen, LuFilePlus2 as FilePlus2, LuFileSymlink as FileSymlink, LuRefreshCw as RefreshCw } from "react-icons/lu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffPatchResult, DiffSummaryResult } from "../../contracts/ipc";
import type { MobileQuery, MobileThreadView } from "../../contracts/mobile";
import { diffRows, fileFingerprint, parseFilePatch, rangeKey, UNCOMMITTED, type DiffFileSummary, type DiffRange, type DiffRow } from "../../domain/diff";

/** A patch drawn whole would take a phone with it, so a long one is cut here until asked for. */
const ROW_CAP = 1_500;

type Summary = { status: "reading" } | DiffSummaryResult;
type Patch = { status: "reading" } | { status: "available"; rows: DiffRow[] } | Exclude<DiffPatchResult, { status: "available" }>;

/** What a comparison the phone cannot draw has to say for itself, or null when it has files to show. */
function summaryNote(summary: Summary): string | null {
  switch (summary.status) {
    case "reading": return "Reading the comparison…";
    case "error": return summary.message;
    case "unknown": return "The checkout is no longer registered.";
    case "unavailable": return `The checkout is ${summary.reason}.`;
    case "available": return summary.files.length ? null : "Nothing has changed in this comparison.";
  }
}

function StatusIcon({ status }: { status: DiffFileSummary["status"] }) {
  if (status === "added" || status === "untracked") return <FilePlus2 size={15} />;
  if (status === "deleted") return <FileMinus2 size={15} />;
  if (status === "renamed") return <FileSymlink size={15} />;
  return <FilePen size={15} />;
}

function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { folder: "", name: path } : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

function Line({ row }: { row: DiffRow }) {
  if (row.kind === "hunk") return <div className="diff-line hunk"><code>{row.text}</code></div>;
  return (
    <div className={`diff-line ${row.kind}`}>
      <span className="diff-gutter" aria-hidden="true">{row.oldLine ?? ""}</span>
      <span className="diff-gutter" aria-hidden="true">{row.newLine ?? ""}</span>
      <code>{row.text || " "}</code>
    </div>
  );
}

function PatchBody({ patch }: { patch: Patch }) {
  const [whole, setWhole] = useState(false);
  if (patch.status === "reading") return <p className="diff-note">Reading the file…</p>;
  if (patch.status === "error") return <p className="diff-note">{patch.message}</p>;
  if (patch.status === "too-large") return <p className="diff-note">This file's patch is too large to read here.</p>;
  const rows = whole ? patch.rows : patch.rows.slice(0, ROW_CAP);
  const hidden = patch.rows.length - rows.length;
  return (
    <div className="diff-body">
      {rows.map((row) => <Line key={row.key} row={row} />)}
      {hidden > 0 && <button type="button" className="diff-more" onClick={() => setWhole(true)}>Show {hidden} more {hidden === 1 ? "line" : "lines"}</button>}
    </div>
  );
}

function FileCard({ file, open, patch, onToggle }: { file: DiffFileSummary; open: boolean; patch: Patch | undefined; onToggle: () => void }) {
  const { folder, name } = splitPath(file.path);
  return (
    <section className="diff-file" data-open={open || undefined}>
      <button type="button" className="diff-file-row" aria-expanded={open} onClick={onToggle}>
        <span className="diff-file-caret" aria-hidden="true">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="diff-file-icon" aria-hidden="true"><StatusIcon status={file.status} /></span>
        <span className="diff-file-name"><em>{folder}</em>{name}</span>
        {file.binary
          ? <span className="diff-file-binary">binary</span>
          : <span className="change-counts"><strong>+{file.additions}</strong><em>−{file.deletions}</em></span>}
      </button>
      {open && (file.binary ? <p className="diff-note">Binary file</p> : patch && <PatchBody patch={patch} />)}
    </section>
  );
}

/**
 * The thread's changes, read from the Mac on demand and held only while this screen is up. Nothing
 * here moves the desktop's own review: the comparison is the phone's to pick, and a file opened
 * here is a file read, not a file ticked.
 */
export function Changes({ thread, live, query }: {
  thread: MobileThreadView;
  /** Whether the line is up. A comparison refused for want of one is asked for again when it is. */
  live: boolean;
  query: (query: MobileQuery) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<"uncommitted" | "branch">("uncommitted");
  const [reads, setReads] = useState(0);
  const [summary, setSummary] = useState<Summary>({ status: "reading" });
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const range: DiffRange = mode === "branch" ? thread.branchRange : UNCOMMITTED;
  const key = rangeKey(range);
  const taskId = thread.id;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    setSummary({ status: "reading" });
    setOpen(new Set());
    query({ kind: "diff-summary", taskId, range }).then(
      (result) => { if (!cancelled) setSummary(result as DiffSummaryResult); },
      (error: unknown) => { if (!cancelled) setSummary({ status: "error", message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
    /** Keyed by what the comparison reduces to, not by the fresh range object. */
  }, [query, taskId, key, reads, live]);

  const files = useMemo(() => summary.status === "available" ? summary.files : [], [summary]);

  /**
   * A file is read when it is opened, and again only when its counts say it has changed underneath.
   * Reads in flight are kept off the render path: a state change must not throw away an answer that
   * is still on its way, only a screen that has gone.
   */
  const patchKey = useCallback((file: DiffFileSummary) => `${key}|${file.path}|${fileFingerprint(file)}`, [key]);
  const asked = useRef(new Set<string>());
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);
  useEffect(() => {
    /** The files on screen are the last comparison's until the next one lands, and are not read against it. */
    if (summary.status !== "available" || rangeKey(summary.range) !== key) return;
    for (const file of files) {
      const held = patchKey(file);
      if (!open.has(file.path) || file.binary || asked.current.has(held)) continue;
      asked.current.add(held);
      setPatches((current) => new Map(current).set(held, { status: "reading" }));
      const settle = (patch: Patch) => { if (!gone.current) setPatches((current) => new Map(current).set(held, patch)); };
      query({ kind: "diff-patch", taskId, range, path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}) }).then(
        (result) => {
          const read = result as DiffPatchResult;
          settle(read.status === "available" ? { status: "available", rows: diffRows(parseFilePatch(read.patch, file.path)) } : read);
        },
        (error: unknown) => {
          /** A refused read is forgotten, so opening the file again asks again. */
          asked.current.delete(held);
          settle({ status: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
    }
    /** Keyed by what the comparison reduces to, not by the fresh range object. */
  }, [summary, files, open, patchKey, query, taskId, key]);

  function toggle(path: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  const note = live ? summaryNote(summary) : "Waiting for the line to come back.";
  const base = thread.branchRange.base;
  return (
    <div className="changes">
      <div className="changes-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Comparison">
          <button type="button" role="radio" aria-checked={mode === "uncommitted"} onClick={() => setMode("uncommitted")}>Uncommitted</button>
          <button type="button" role="radio" aria-checked={mode === "branch"} onClick={() => setMode("branch")}>Against {base}</button>
        </div>
        <button type="button" className="ghost icon changes-refresh" aria-label="Read the comparison again" onClick={() => { asked.current.clear(); setPatches(new Map()); setReads((count) => count + 1); }}>
          <RefreshCw size={17} className={summary.status === "reading" ? "spinning" : undefined} />
        </button>
      </div>
      {summary.status === "available" && summary.files.length > 0 && (
        <p className="changes-progress">
          <span>{summary.files.length} {summary.files.length === 1 ? "file" : "files"}</span>
          <span className="change-counts"><strong>+{summary.additions}</strong><em>−{summary.deletions}</em></span>
        </p>
      )}
      {note && <p className="changes-note" role="status">{note}</p>}
      <div className="changes-files">
        {files.map((file) => <FileCard key={file.path} file={file} open={open.has(file.path)} patch={patches.get(patchKey(file))} onToggle={() => toggle(file.path)} />)}
      </div>
    </div>
  );
}
