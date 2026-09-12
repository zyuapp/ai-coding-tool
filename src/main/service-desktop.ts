import type { AgentEngine } from "../domain/agent-engine.js";
import type { ComputerUsePermission, ComputerUsePermissions } from "../domain/computer-use.js";
import { terminalLineLimit } from "../domain/terminal.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import type { PullRequestAnswer } from "../domain/pull-request.js";
import type { RunCommand } from "../contracts/ipc.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import type { TaskDatabaseService } from "./task-database-service.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import { readAttachmentContext, savedAttachmentPath, writeAttachment } from "./attachment-store.js";
import { cliStatus, installCli, uninstallCli } from "./cli-install.js";
import type { DesktopEvents } from "./desktop-events.js";
import { preserveMessageImages } from "./message-image-store.js";
import type { RunBridge } from "./run-host.js";
import * as terminal from "./terminal-host.js";

/** The services every host has, whether or not a window is drawn over them. */
export type ServiceDesktopHost = {
  events: DesktopEvents;
  runs: RunBridge;
  workspaces: () => WorkspaceService;
  worktrees: () => WorktreeService;
  taskDatabase: () => TaskDatabaseService;
  scheduler: () => AutomationScheduler;
  engineAccess: () => Promise<EngineAccessHost>;
  /** The roots the app keeps checkouts under, which a folder the user names may not be inside. */
  worktreesRoots: () => string[];
  /** Where an engine's sign-in page goes: the browser beside a window, the terminal behind a server. */
  openUrl: (url: string) => Promise<void>;
  computerUse: {
    permissions: () => Promise<ComputerUsePermissions>;
    enable: (permission: ComputerUsePermission) => Promise<ComputerUsePermissions>;
  };
};

function failed(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Folders, checkouts, and what Git and GitHub say about them. */
function workspaceDesktop(host: ServiceDesktopHost) {
  const { events } = host;
  async function resolved(workspaceId: string) {
    const resolution = await host.workspaces().resolve(workspaceId);
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    return resolution.workspace.root;
  }
  return {
    registerProject: async (root) => {
      const { projectFolder } = await import("./project-folder.mjs");
      return (await host.workspaces().registerProject(await projectFolder(root, host.worktreesRoots()))).workspace;
    },
    onOpenProject: (listener) => events.on("workspace:open-project", listener),
    projectlessWorkspace: async () => (await host.workspaces().getProjectless()).workspace,
    changedFiles: async (workspaceId) => {
      try {
        const { changedFiles } = await import("./workspace/git-changes.mjs");
        return await changedFiles(workspaceId, host.workspaces());
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    diffSummary: async (workspaceId, range, ignoreWhitespace) => {
      try {
        const { diffSummary } = await import("./workspace/git-diff.mjs");
        return await diffSummary(workspaceId, range, host.workspaces(), ignoreWhitespace === true);
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    diffPatch: async (workspaceId, range, filePath, previousPath, ignoreWhitespace) => {
      try {
        const { diffPatch } = await import("./workspace/git-diff.mjs");
        return await diffPatch(workspaceId, range, filePath, host.workspaces(), previousPath, ignoreWhitespace === true);
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    pullRequest: async (workspaceId): Promise<PullRequestAnswer> => {
      try {
        const resolution = await host.workspaces().resolve(workspaceId);
        if (resolution.status !== "available") return { status: "none" };
        const { pullRequestFor } = await import("./workspace/github.mjs");
        return await pullRequestFor(resolution.workspace.root);
      } catch {
        return { status: "none" };
      }
    },
    checkoutBranch: async (workspaceId, branch) => {
      const { checkoutBranch } = await import("./workspace/git.mjs");
      await checkoutBranch(await resolved(workspaceId), branch);
    },
    createBranch: async (workspaceId, branch) => {
      const { createBranch } = await import("./workspace/git.mjs");
      await createBranch(await resolved(workspaceId), branch);
    },
    createWorktree: (request) => host.worktrees().create(request),
    listManagedWorktrees: () => host.worktrees().list(),
    releaseWorktree: (request) => host.worktrees().release(request),
  } satisfies Partial<RuntimeDesktop>;
}

/** Files on disk, the engines, storage, and schedules. */
function storeDesktop(host: ServiceDesktopHost) {
  const { events } = host;
  return {
    cliStatus,
    installCli,
    uninstallCli,
    computerUsePermissions: () => host.computerUse.permissions(),
    enableComputerUse: (permission) => host.computerUse.enable(permission),
    planUsage: async (engine: AgentEngine): Promise<PlanUsage> => {
      try {
        const { engineServices } = await import("./agent/engine-services.mjs");
        return await engineServices[engine].planUsage();
      } catch (cause) {
        return { status: "unavailable", message: failed(cause) };
      }
    },
    send: (command: RunCommand) => host.runs.submit(command),
    onAgentEvent: (listener) => events.on("run:event", listener),
    saveAttachment: async (data, original) => {
      if (original !== undefined && !savedAttachmentPath(original)) throw new Error("That image is not one this app is keeping.");
      const context = original === undefined ? null : await readAttachmentContext(original);
      return writeAttachment(data, context);
    },
    preserveMessageImages: (files, root, messageId) => preserveMessageImages(files, root, messageId),
    suggestTaskTitle: async (text, attachments, engine) => {
      const images = attachments.map((item) => savedAttachmentPath(item)).filter((file): file is string => file !== null);
      if (!text.trim() && images.length === 0) return null;
      try {
        const { engineServices } = await import("./agent/engine-services.mjs");
        return await engineServices[engine].suggestTitle(text, images);
      } catch {
        return null;
      }
    },
    engineStatus: async (refresh) => (await host.engineAccess()).read(refresh === true),
    signInEngine: async (engine) => (await host.engineAccess()).signIn(engine, host.openUrl),
    loadTaskStore: () => host.taskDatabase().loadSummaries(),
    loadThreadMessages: (taskId) => host.taskDatabase().loadThreadMessages(taskId),
    persistTaskStore: (delta) => host.taskDatabase().persist(delta),
    loadSubagentActivity: (taskId, subagentId) => host.taskDatabase().subagentActivity(taskId, subagentId),
    listAutomations: async () => host.scheduler().list(),
    saveAutomation: (draft) => host.scheduler().save(draft),
    updateAutomation: (taskId, patch) => host.scheduler().update(taskId, patch),
    deleteAutomation: (taskId) => host.scheduler().remove(taskId),
    runAutomationNow: (taskId) => host.scheduler().runNow(taskId),
    onAutomationsChanged: (listener) => events.on("automation:changed", listener),
    onAutomationFire: (listener) => events.on("automation:fire", listener),
    acknowledgeAutomation: (ack) => host.runs.acknowledgeAutomation(ack.runId, ack.started),
    onThreadRequest: (listener) => events.on("thread:request", listener),
    answerThreadRequest: (response) => host.runs.answerThread(response),
  } satisfies Partial<RuntimeDesktop>;
}

/** The terminal panel's shells, which run wherever the runtime does. */
function terminalDesktop(host: ServiceDesktopHost) {
  return {
    startTerminal: async (terminalId, options) => terminal.startTerminal(terminalId, options.cwd),
    writeTerminal: async (terminalId, data) => terminal.writeTerminal(terminalId, data),
    resizeTerminal: async (terminalId, cols, rows) => terminal.resizeTerminal(terminalId, cols, rows),
    closeTerminal: async (terminalId) => terminal.closeTerminal(terminalId),
    readTerminal: (terminalId, options) => terminal.readTerminal(terminalId, { lines: terminalLineLimit(options.lines), ...(options.match ? { match: options.match } : {}) }),
    onTerminalEvent: (listener) => host.events.on("terminal:event", listener),
  } satisfies Partial<RuntimeDesktop>;
}

/** What every host answers the runtime with, in the process that owns the services. */
export function serviceDesktop(host: ServiceDesktopHost) {
  return { ...workspaceDesktop(host), ...storeDesktop(host), ...terminalDesktop(host) };
}

export type ServiceDesktop = ReturnType<typeof serviceDesktop>;
