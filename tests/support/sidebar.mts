import React from "react";
import type { Thread } from "../../src/domain/thread.ts";
import type { AutomationView } from "../../src/domain/automation.ts";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";
import "./renderer-dom.mts";

const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

export function renderProjectSidebar(overrides: Partial<ProjectSidebarProps>) {
  return React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [],
    currentId: null,
    runningThreadIds: new Set<string>(),
    monitoringThreadIds: new Set<string>(),
    blockedThreadIds: new Set<string>(),
    sideChatAttention: new Set<string>(),
    schedules: new Map<string, AutomationView>(),
    limitPositions: new Map<string, number>(),
    worktreeGroups: [],
    sidebarCoordination: { threadsByCoordinator: new Map(), waitingLines: new Map(), coordinatorsByComputer: new Map([[null, []]]), onSetCoordinator() {}, notifications: true, onSetMuted() {}, stoppable: new Set<string>(), onStopAll() {} },
    worktreeThreadIds: new Set<string>(),
    activityThreads: { priority: [], running: [], threads: [], snoozed: [] },
    threadHosts: new Map(),
    projectHosts: new Map(),
    computerLinks: [],
    computerName: "This Mac",
    computerFilter: "all",
    onSetComputerFilter() {},
    activityProject: null,
    onSetActivityProject() {},
    sections: { priority: true, running: true, threads: true, snoozed: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {},
    onGoForward() {},
    onNewThread() {},
    onOpenFolder() {},
    onSetSectionOpen() {},
    onSetOpenMenu() {},
    onSelectThread() {},
    onArchiveThread() {},
    onDismissThread() {},
    onSnoozeThread() {},
    onUnsnoozeThread() {},
    onDismissAll() {},
    onRenameThread() {},
    onMoveThread() {}, onForkThread() {}, onSetThreadRole() {},
    onOpenSettings() {},
    appUpdate: { status: "idle" }, onDownloadUpdate() {}, onInstallUpdate() {},
    ...overrides,
  });
}

export type SeedProjectThread = Pick<Thread, "id" | "title" | "updatedAt"> & Partial<Thread>;

export function seedProjectTasks(tasks: SeedProjectThread[]) {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: tasks.map((task) => ({
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuationStatus: "none",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      projectId: "project-1",
      ...task,
    })) }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/project" }] }),
    lastFolder: JSON.stringify({ version: 2, value: "/project" }),
  }));
}
