import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import type { CreateWorktreeRequest, ReleaseWorktreeRequest } from "../contracts/ipc.js";
import type { PullRequestAnswer } from "../domain/pull-request.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };

/** The services a checkout question is answered from, taken late so neither has to exist yet. */
export type WorkspaceIpcHost = {
  workspaces: () => WorkspaceService;
  worktrees: () => WorktreeService;
};

function worktreeRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid worktree request.");
  return value as Record<string, unknown>;
}

function worktreePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4_096) throw new Error("Invalid worktree path.");
  return value;
}

async function readChangedFiles(host: WorkspaceIpcHost, workspaceId: string) {
  const { changedFiles } = await import("./workspace/git-changes.mjs");
  return changedFiles(workspaceId, host.workspaces());
}

export function registerWorkspaceIpc(host: WorkspaceIpcHost, trusted: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle("workspace:branches", async (event, workspaceId: unknown) => {
    if (!trusted(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
    try {
      const resolution = await host.workspaces().resolve(worktreePath(workspaceId));
      if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
      const { listBranches } = await import("./workspace/git.mjs");
      return { status: "available", ...(await listBranches(resolution.workspace.root)) } as const;
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
    }
  });

  /** Best effort throughout: a checkout the app cannot even resolve has nothing to say about one. */
  ipcMain.handle("workspace:pull-request", async (event, workspaceId: unknown): Promise<PullRequestAnswer> => {
    if (!trusted(event)) return { status: "none" };
    try {
      const resolution = await host.workspaces().resolve(worktreePath(workspaceId));
      if (resolution.status !== "available") return { status: "none" };
      const { pullRequestFor } = await import("./workspace/github.mjs");
      return await pullRequestFor(resolution.workspace.root);
    } catch {
      return { status: "none" };
    }
  });

  ipcMain.handle("workspace:checkout-branch", async (event, workspaceId: unknown, branch: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const resolution = await host.workspaces().resolve(worktreePath(workspaceId));
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    const { checkoutBranch } = await import("./workspace/git.mjs");
    await checkoutBranch(resolution.workspace.root, worktreePath(branch));
  });

  ipcMain.handle("workspace:create-branch", async (event, workspaceId: unknown, branch: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const resolution = await host.workspaces().resolve(worktreePath(workspaceId));
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    const { createBranch } = await import("./workspace/git.mjs");
    await createBranch(resolution.workspace.root, worktreePath(branch));
  });

  ipcMain.handle("worktree:create", async (event, request: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const fields = worktreeRequest(request);
    return host.worktrees().create({
      projectRoot: worktreePath(fields.projectRoot),
      carryChanges: fields.carryChanges === true,
      ...(typeof fields.branch === "string" && fields.branch ? { branch: fields.branch } : {}),
    } satisfies CreateWorktreeRequest);
  });

  ipcMain.handle("worktree:list", async (event) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    return host.worktrees().list();
  });

  ipcMain.handle("worktree:reveal", async (event, root: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    shell.showItemInFolder(await host.worktrees().ownedPath(worktreePath(root)));
  });

  ipcMain.handle("worktree:release", async (event, request: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const fields = worktreeRequest(request);
    const release = fields.release === "deleted" ? "deleted" : "returned-to-local";
    return host.worktrees().release({
      worktreeId: worktreePath(fields.worktreeId),
      root: worktreePath(fields.root),
      taskId: typeof fields.taskId === "string" ? worktreePath(fields.taskId) : null,
      title: typeof fields.title === "string" ? fields.title : "",
      release,
    } satisfies ReleaseWorktreeRequest);
  });

  ipcMain.handle("workspace:changed-files", async (event, workspaceId: unknown) => {
    if (!trusted(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
    if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
    try {
      return await readChangedFiles(host, workspaceId);
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
    }
  });

  ipcMain.handle("workspace:diff-summary", async (event, workspaceId: unknown, range: unknown, ignoreWhitespace: unknown) => {
    if (!trusted(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
    if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
    const { isDiffRange } = await import("../domain/diff.js");
    if (!isDiffRange(range)) return { status: "error", message: "Invalid comparison." } as const;
    try {
      const { diffSummary } = await import("./workspace/git-diff.mjs");
      return await diffSummary(workspaceId, range, host.workspaces(), ignoreWhitespace === true);
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
    }
  });

  ipcMain.handle("workspace:diff-patch", async (event, workspaceId: unknown, range: unknown, filePath: unknown, previousPath: unknown, ignoreWhitespace: unknown) => {
    if (!trusted(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
    if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 4_096) return { status: "error", message: "Invalid path." } as const;
    if (previousPath !== undefined && (typeof previousPath !== "string" || previousPath.length === 0 || previousPath.length > 4_096)) return { status: "error", message: "Invalid path." } as const;
    const { isDiffRange } = await import("../domain/diff.js");
    if (!isDiffRange(range)) return { status: "error", message: "Invalid comparison." } as const;
    try {
      const { diffPatch } = await import("./workspace/git-diff.mjs");
      return await diffPatch(workspaceId, range, filePath, host.workspaces(), previousPath, ignoreWhitespace === true);
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
    }
  });
}
