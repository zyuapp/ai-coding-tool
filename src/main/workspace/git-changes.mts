import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFilesResult } from "../../contracts/ipc.js";
import { UnknownWorkspaceError, type WorkspaceService } from "./workspace-service.mjs";

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: resolved.workspace.root,
      timeout: 5_000,
    });
    return { status: "available", files: stdout.split("\n").filter(Boolean) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
