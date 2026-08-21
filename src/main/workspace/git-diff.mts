import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffFileStatus, DiffFileSummary, DiffRange } from "../../domain/diff.js";
import type { DiffPatchResult, DiffSummaryResult } from "../../contracts/ipc.js";
import { UnknownWorkspaceError, type WorkspaceService } from "./workspace-service.mjs";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;

/** Patches past this are not worth drawing, and the file is offered to an editor instead. */
export const PATCH_LIMIT = 2_000_000;

/** How much unchanged code surrounds each hunk. Three is what Git and every review tool default to. */
const CONTEXT = 3;

async function run(root: string, args: string[], limit = PATCH_LIMIT) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: TIMEOUT_MS, maxBuffer: limit * 2 });
  return stdout;
}

/**
 * `git diff` exits 1 whenever it found differences, which `--no-index` makes the normal case, so its
 * output is the answer rather than the failure Node reports it as.
 */
async function runAllowingDifferences(root: string, args: string[]) {
  try {
    return await run(root, args);
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
    throw error;
  }
}

/**
 * Where a comparison starts. Branch comparisons measure from where the two sides last agreed, so a
 * base that has moved ahead does not report its own commits as the thread's work.
 */
async function resolveBase(root: string, range: DiffRange) {
  if (range.kind === "uncommitted") return "HEAD";
  const head = range.compare ?? "HEAD";
  try {
    const mergeBase = (await run(root, ["merge-base", range.base, head])).trim();
    if (mergeBase) return mergeBase;
  } catch {
    // A base the checkout does not have is compared against directly, and Git says so if it cannot.
  }
  return range.base;
}

/** The revisions a `git diff` for this range takes, with the working tree left as the absent side. */
async function revisions(root: string, range: DiffRange) {
  const base = await resolveBase(root, range);
  const compare = range.kind === "uncommitted" ? null : range.compare;
  return compare ? [base, compare] : [base];
}

/**
 * Files Git is not tracking. They have no diff of their own, so they are listed here and patched
 * with `--no-index` when one is opened.
 */
async function untrackedFiles(root: string) {
  const stdout = await run(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return stdout.split("\0").filter(Boolean);
}

async function untrackedSummary(root: string, file: string): Promise<DiffFileSummary | null> {
  const candidate = path.resolve(root, file);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile()) return null;
    const patch = await runAllowingDifferences(root, ["diff", "--numstat", "-z", "--no-index", "--", "/dev/null", file]);
    const [added, deleted] = patch.split("\0")[0]?.split("\t") ?? [];
    const binary = added === "-" || deleted === "-";
    return { path: file, status: "untracked", additions: binary ? 0 : Number(added) || 0, deletions: 0, binary };
  } catch {
    return null;
  }
}

const STATUSES: Record<string, DiffFileStatus> = { A: "added", D: "deleted", R: "renamed", C: "added", M: "modified", T: "modified" };

/**
 * `--numstat -z` writes counts and paths, and a rename writes both of its paths, so records are read
 * with a cursor rather than split into fixed groups.
 */
function readNumstat(output: string, statuses: Map<string, DiffFileStatus>) {
  const fields = output.split("\0");
  const files: DiffFileSummary[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    const [added, deleted, inlinePath] = record.split("\t");
    if (added === undefined || deleted === undefined) continue;
    let previousPath: string | undefined;
    let filePath = inlinePath;
    if (!filePath) {
      previousPath = fields[index + 1];
      filePath = fields[index + 2];
      index += 2;
      if (!filePath) continue;
    }
    const binary = added === "-" || deleted === "-";
    files.push({
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      status: statuses.get(filePath) ?? (previousPath ? "renamed" : "modified"),
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return files;
}

/** What happened to each file, which `--numstat` does not say and `--name-status` does. */
function readNameStatus(output: string) {
  const fields = output.split("\0");
  const statuses = new Map<string, DiffFileStatus>();
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index];
    if (!code) continue;
    const status = STATUSES[code[0]];
    if (!status) continue;
    /** A rename writes its old path then its new one; the new one is what the list is keyed by. */
    const renamed = code[0] === "R" || code[0] === "C";
    const target = renamed ? fields[index + 2] : fields[index + 1];
    index += renamed ? 2 : 1;
    if (target) statuses.set(target, status);
  }
  return statuses;
}

export async function diffSummary(workspaceId: string, range: DiffRange, workspaces: WorkspaceService): Promise<DiffSummaryResult> {
  let resolved;
  try {
    resolved = await workspaces.resolve(workspaceId);
  } catch (error) {
    if (error instanceof UnknownWorkspaceError) return { status: "unknown", workspaceId };
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (resolved.status === "unavailable") return { status: "unavailable", reason: resolved.reason };

  try {
    const root = resolved.workspace.root;
    const revs = await revisions(root, range);
    const [numstat, nameStatus, untracked] = await Promise.all([
      run(root, ["diff", "--numstat", "-z", "--find-renames", ...revs, "--"]),
      run(root, ["diff", "--name-status", "-z", "--find-renames", ...revs, "--"]),
      /** Only a comparison that ends at the working tree can have files Git has never seen. */
      range.kind === "uncommitted" || range.compare === null ? untrackedFiles(root) : Promise.resolve([]),
    ]);
    const tracked = readNumstat(numstat, readNameStatus(nameStatus));
    const fresh = (await Promise.all(untracked.map((file) => untrackedSummary(root, file)))).filter((file): file is DiffFileSummary => file !== null);
    const files = [...tracked, ...fresh].sort((a, b) => a.path.localeCompare(b.path));
    return {
      status: "available",
      range,
      files,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function diffPatch(workspaceId: string, range: DiffRange, filePath: string, workspaces: WorkspaceService): Promise<DiffPatchResult> {
  let resolved;
  try {
    resolved = await workspaces.resolve(workspaceId);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (resolved.status !== "available") return { status: "error", message: `Workspace is ${resolved.status === "unavailable" ? resolved.reason : "unavailable"}.` };

  const root = resolved.workspace.root;
  const candidate = path.resolve(root, filePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { status: "error", message: "Path is outside the workspace." };

  try {
    const revs = await revisions(root, range);
    const patch = await run(root, ["diff", `-U${CONTEXT}`, "--find-renames", ...revs, "--", filePath]);
    /** Nothing tracked answers for a file Git has never seen, so it is diffed against emptiness. */
    if (patch.trim()) return { status: "available", patch };
    const fresh = await runAllowingDifferences(root, ["diff", `-U${CONTEXT}`, "--no-index", "--", "/dev/null", filePath]);
    return { status: "available", patch: fresh };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { status: "too-large", limit: PATCH_LIMIT };
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
