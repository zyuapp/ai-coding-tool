/**
 * Unified diff as data. Git speaks patch text; the panel draws rows. Everything between the two is
 * here, pure, so the shape a row has is settled once rather than inside the component that draws it.
 */

/** What happened to a file between the two sides being compared. */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** One file in a comparison, before its patch is read. Counts come from Git, not from the patch. */
export type DiffFileSummary = {
  path: string;
  /** Where a renamed file came from. */
  previousPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DiffLineKind = "context" | "add" | "delete";

/**
 * One drawn line. A hunk header is a row of its own so the list stays flat and every row costs the
 * same to measure. Line numbers are absent on the side the line is not on.
 */
export type DiffRow =
  | { kind: "hunk"; key: string; text: string }
  | { kind: DiffLineKind; key: string; text: string; oldLine: number | null; newLine: number | null };

/** A contiguous run of lines, which is the largest block that can be tokenized as one piece. */
export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: Array<Extract<DiffRow, { kind: DiffLineKind }>>;
};

export type DiffFile = {
  path: string;
  previousPath?: string;
  hunks: DiffHunk[];
};

/** Which side of the comparison a line belongs to, for a comment that has to name one. */
export type DiffSide = "old" | "new";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * The patch for one file, as `git diff` writes it. Only the first file's headers are read: callers
 * ask for one path at a time, and `--no-index` on an untracked file names it with a `/dev/null` side.
 */
export function parseFilePatch(patch: string, fallbackPath: string): DiffFile {
  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let path = fallbackPath;
  let previousPath: string | undefined;
  let current: DiffHunk | null = null;
  let hunkIndex = -1;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("--- ") && line !== "--- /dev/null") {
      const named = line.slice(4).replace(/^a\//, "");
      if (named !== path) previousPath = named;
      continue;
    }
    if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunkIndex = hunks.length;
      /** A range without a count is one line long, which is how Git writes `@@ -1 +1 @@`. */
      current = {
        header: header[5].trim(),
        oldStart: oldLine,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newLine,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        rows: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    /** A patch's last line is empty after the split, and "\ No newline" annotates rather than adds. */
    if (line === "" || line.startsWith("\\")) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      current.rows.push({ kind: "add", key: `${hunkIndex}:n${newLine}`, text, oldLine: null, newLine });
      newLine += 1;
    } else if (marker === "-") {
      current.rows.push({ kind: "delete", key: `${hunkIndex}:o${oldLine}`, text, oldLine, newLine: null });
      oldLine += 1;
    } else if (marker === " ") {
      current.rows.push({ kind: "context", key: `${hunkIndex}:c${oldLine}:${newLine}`, text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { path, ...(previousPath && previousPath !== path ? { previousPath } : {}), hunks };
}

/** The flat row list the panel draws, hunk headers included, keyed so windowing can track rows. */
export function diffRows(file: DiffFile): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [index, hunk] of file.hunks.entries()) {
    rows.push({ kind: "hunk", key: `h${index}`, text: hunkLabel(hunk) });
    for (const row of hunk.rows) rows.push(row);
  }
  return rows;
}

/** The header Git itself writes, counts and all, so a hunk reads the same here as anywhere else. */
function hunkLabel(hunk: DiffHunk) {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return hunk.header ? `${range} ${hunk.header}` : range;
}

/**
 * One side of a hunk as the text it was cut from, which is what a highlighter has to see: tokenizing
 * a line alone loses whatever state opened above it, so a hunk is the smallest honest unit.
 */
export function hunkText(hunk: DiffHunk, side: DiffSide) {
  const lines: string[] = [];
  for (const row of hunk.rows) {
    if (side === "old" ? row.kind !== "add" : row.kind !== "delete") lines.push(row.text);
  }
  return lines.join("\n");
}

/** Where each of a hunk's rows lands in {@link hunkText}, so a token line can find the row it draws. */
export function hunkTextIndex(hunk: DiffHunk, side: DiffSide) {
  const index = new Map<string, number>();
  let line = 0;
  for (const row of hunk.rows) {
    if (side === "old" ? row.kind === "add" : row.kind === "delete") continue;
    index.set(row.key, line);
    line += 1;
  }
  return index;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  markdown: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  py: "python",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

/** The grammar a path asks for, or null for one nothing here can read, which draws as plain rows. */
export function languageForPath(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES[extension] ?? null;
}

/** Which line numbers a row carries on a given side, for turning a selection into a range. */
function lineOn(row: DiffRow, side: DiffSide) {
  if (row.kind === "hunk") return null;
  return side === "old" ? row.oldLine : row.newLine;
}

/**
 * How a selected range reaches the agent: the file and the lines it names, then the lines themselves
 * with their diff markers kept, so the model reads the same thing the user was looking at.
 */
export function commentQuote(path: string, rows: DiffRow[], side: DiffSide) {
  const numbered = rows.filter((row) => row.kind !== "hunk");
  const lines = numbered.map((row) => lineOn(row, side)).filter((line): line is number => line !== null);
  const first = lines[0] ?? null;
  const last = lines[lines.length - 1] ?? null;
  const range = first === null ? "" : first === last ? `:L${first}` : `:L${first}-L${last}`;
  const body = numbered.map((row) => `${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " "}${row.text}`);
  return [`${path}${range}`, ...body].join("\n");
}

/** A file's counts, used to notice that a file marked viewed has changed since it was marked. */
export function fileFingerprint(file: DiffFileSummary) {
  return `${file.status}:${file.additions}:${file.deletions}`;
}

/**
 * What the panel is comparing. `uncommitted` is the working tree against HEAD, which is the shape a
 * thread's own edits have before anything is committed. `branches` compares from where the two sides
 * last agreed, the way a pull request reads, and a null `compare` means the working tree itself.
 */
export type DiffRange =
  | { kind: "uncommitted" }
  | { kind: "branches"; base: string; compare: string | null };

export const UNCOMMITTED: DiffRange = { kind: "uncommitted" };

export function rangeKey(range: DiffRange) {
  return range.kind === "uncommitted" ? "uncommitted" : `branches:${range.base}:${range.compare ?? ""}`;
}

export function isDiffRange(value: unknown): value is DiffRange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "uncommitted") return true;
  return candidate.kind === "branches"
    && typeof candidate.base === "string"
    && candidate.base.length > 0
    && (candidate.compare === null || typeof candidate.compare === "string");
}

/** A line of the two-column view: what the old side had beside what the new side has. */
export type DiffPair = { kind: "pair"; key: string; left: DiffRow | null; right: DiffRow | null };

export type SplitRow = Extract<DiffRow, { kind: "hunk" }> | DiffPair;

/**
 * The same rows in two columns. Deletions and the additions that replaced them are drawn on one line
 * so a rewrite reads across rather than down; a run that is longer on one side leaves gaps. Rows keep
 * their parsed keys, so both views look their tokens up the same way.
 */
export function splitRows(file: DiffFile): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const [index, hunk] of file.hunks.entries()) {
    rows.push({ kind: "hunk", key: `h${index}`, text: hunkLabel(hunk) });
    let cursor = 0;
    while (cursor < hunk.rows.length) {
      const source = hunk.rows[cursor]!;
      if (source.kind === "context") {
        rows.push({ kind: "pair", key: source.key, left: source, right: source });
        cursor += 1;
        continue;
      }
      const deletions: DiffHunk["rows"] = [];
      const additions: DiffHunk["rows"] = [];
      while (cursor < hunk.rows.length && hunk.rows[cursor]!.kind === "delete") {
        const row = hunk.rows[cursor++]!;
        deletions.push(row);
      }
      while (cursor < hunk.rows.length && hunk.rows[cursor]!.kind === "add") {
        const row = hunk.rows[cursor++]!;
        additions.push(row);
      }
      for (let offset = 0; offset < Math.max(deletions.length, additions.length); offset += 1) {
        const left = deletions[offset] ?? null;
        const right = additions[offset] ?? null;
        rows.push({ kind: "pair", key: `${left?.key ?? ""}|${right?.key ?? ""}`, left, right });
      }
    }
  }
  return rows;
}
