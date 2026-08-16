import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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
      const metadata = await stat(candidate);
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
    const [{ stdout: statusOutput }, { stdout: numstatOutput }, branch] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: root, timeout: 5_000 }),
      execFileAsync("git", ["diff", "--numstat", "-z", "HEAD", "--"], { cwd: root, timeout: 5_000 }),
      branchName(root),
    ]);
    const statusRecords = statusOutput.split("\0").filter(Boolean);
    const untracked = statusRecords.filter((record) => record.startsWith("?? ")).map((record) => record.slice(3));
    const totals = summarizeNumstat(numstatOutput);
    totals.additions += await untrackedLines(root, untracked);
    return { status: "available", files: statusRecords, branch, ...totals };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
