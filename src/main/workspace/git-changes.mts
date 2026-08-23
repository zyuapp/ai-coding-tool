import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFilesResult } from "../../contracts/ipc.js";
import { UnknownWorkspaceError, type WorkspaceService } from "./workspace-service.mjs";

const execFileAsync = promisify(execFile);

/** Long enough for the two-second environment poll to reuse, short enough to follow fetched refs. */
const BASE_TTL_MS = 30_000;

/** File reads are independent, but an untracked directory must not open everything at once. */
const UNTRACKED_CONCURRENCY = 8;

export function summarizeNumstat(output: string) {
  let additions = 0;
  let deletions = 0;
  for (const record of output.split("\0")) {
    const [added, deleted] = record.split("\t");
    if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) {
      additions += Number(added);
      deletions += Number(deleted);
    }
  }
  return { additions, deletions };
}

async function untrackedFileLines(root: string, file: string) {
  const candidate = path.resolve(root, file);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return 0;
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.size > 5_000_000) return 0;
    const contents = await readFile(candidate);
    if (contents.includes(0)) return 0;
    return contents.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (contents.length > 0 && contents.at(-1) !== 10 ? 1 : 0);
  } catch {
    // The file may disappear while Git and the filesystem are being sampled.
    return 0;
  }
}

async function untrackedLines(root: string, files: string[]) {
  const counts = new Array<number>(files.length).fill(0);
  let cursor = 0;
  const read = async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      counts[index] = await untrackedFileLines(root, files[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_CONCURRENCY, files.length) }, read));
  return counts.reduce((total, count) => total + count, 0);
}

async function readGit(root: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Where the counts are measured from: the commit at which HEAD left the origin default branch, so
 * work a thread has already committed keeps counting. Null when there is no origin to compare
 * against, which leaves the working tree alone as the answer. Nothing is fetched, so the baseline is
 * as current as the last fetch.
 */
type ComparisonBase = { ref: string; commit: string } | null;

async function resolveComparisonBase(root: string): Promise<ComparisonBase> {
  const remoteHead = await readGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = new Set([remoteHead?.replace(/^refs\/remotes\//, ""), "origin/main", "origin/master"]);
  for (const ref of candidates) {
    if (!ref) continue;
    const commit = await readGit(root, ["merge-base", ref, "HEAD"]);
    if (commit) return { ref, commit };
  }
  return null;
}

type CachedComparisonBase = { head: string; base: Promise<ComparisonBase> };

/** A poll asks for the same HEAD repeatedly, so one repository shares both in-flight and settled reads. */
const comparisonBases = new Map<string, CachedComparisonBase>();

async function comparisonBase(root: string, head: string, resolving?: Promise<ComparisonBase>) {
  const key = path.resolve(root);
  const cached = comparisonBases.get(key);
  if (cached?.head === head) return cached.base;
  const entry = { head, base: resolving ?? resolveComparisonBase(root) };
  comparisonBases.set(key, entry);
  setTimeout(() => {
    if (comparisonBases.get(key) === entry) comparisonBases.delete(key);
  }, BASE_TTL_MS).unref?.();
  return entry.base;
}

async function headState(root: string) {
  const [commit, branch] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, timeout: 5_000 }),
    branchName(root),
  ]);
  return { commit: commit.stdout.trim(), branch };
}

async function branchName(root: string) {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 5_000 });
    return stdout.trim() ? `detached@${stdout.trim()}` : null;
  }
}

export async function changedFiles(workspaceId: string, workspaces: Pick<WorkspaceService, "resolve">): Promise<ChangedFilesResult> {
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
    const cached = comparisonBases.get(path.resolve(root));
    const resolving = cached ? undefined : resolveComparisonBase(root);
    const head = await headState(root);
    const base = await comparisonBase(root, head.commit, resolving);
    const [{ stdout: statusOutput }, { stdout: numstatOutput }] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: root, timeout: 5_000 }),
      execFileAsync("git", ["diff", "--numstat", "-z", base?.commit ?? "HEAD", "--"], { cwd: root, timeout: 5_000 }),
    ]);
    const statusRecords = statusOutput.split("\0").filter(Boolean);
    const untracked = statusRecords.filter((record) => record.startsWith("?? ")).map((record) => record.slice(3));
    const totals = summarizeNumstat(numstatOutput);
    totals.additions += await untrackedLines(root, untracked);
    return { status: "available", files: statusRecords, branch: head.branch, baseline: base?.ref ?? null, ...totals };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
