import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFilesResult } from "../../contracts/ipc.js";
import { UnknownWorkspaceError, type WorkspaceService } from "./workspace-service.mjs";

const execFileAsync = promisify(execFile);

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

async function untrackedLines(root: string, files: string[]) {
  let additions = 0;
  for (const file of files) {
    const candidate = path.resolve(root, file);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.size > 5_000_000) continue;
      const contents = await readFile(candidate);
      if (contents.includes(0)) continue;
      additions += contents.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (contents.length > 0 && contents.at(-1) !== 10 ? 1 : 0);
    } catch {
      // The file may disappear while Git and the filesystem are being sampled.
    }
  }
  return additions;
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
async function comparisonBase(root: string) {
  const remoteHead = await readGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = new Set([remoteHead?.replace(/^refs\/remotes\//, ""), "origin/main", "origin/master"]);
  for (const ref of candidates) {
    if (!ref) continue;
    const commit = await readGit(root, ["merge-base", ref, "HEAD"]);
    if (commit) return { ref, commit };
  }
  return null;
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

export async function changedFiles(workspaceId: string, workspaces: WorkspaceService): Promise<ChangedFilesResult> {
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
    const base = await comparisonBase(root);
    const [{ stdout: statusOutput }, { stdout: numstatOutput }, branch] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: root, timeout: 5_000 }),
      execFileAsync("git", ["diff", "--numstat", "-z", base?.commit ?? "HEAD", "--"], { cwd: root, timeout: 5_000 }),
      branchName(root),
    ]);
    const statusRecords = statusOutput.split("\0").filter(Boolean);
    const untracked = statusRecords.filter((record) => record.startsWith("?? ")).map((record) => record.slice(3));
    const totals = summarizeNumstat(numstatOutput);
    totals.additions += await untrackedLines(root, untracked);
    return { status: "available", files: statusRecords, branch, baseline: base?.ref ?? null, ...totals };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
