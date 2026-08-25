import { AlarmClock, Bot, Boxes, FileDiff, GitFork, Globe, SquareTerminal, type LucideIcon } from "lucide-react";
import { AutomationPanel } from "./AutomationPanel";
import { DiffPanel } from "./DiffPanel";
import { AgentsPanel } from "./SubagentList";
import { SubagentInspector } from "./SubagentInspector";
import { WorkflowPanel } from "./WorkflowPanel";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { DIFF_PANEL } from "../../application/workspace-reducer";
import type { DiffState } from "../../application/workspace-state";
import type { FindTarget } from "../../domain/find";
import type { ReactNode } from "react";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/**
 * A view in the right dock that there is only ever one of. Pages, shells and side chats are tabs of
 * their own instead: they are opened by a launcher below and drawn from the workspace's own records.
 */
export type DockPanel = {
  id: string;
  title: string;
  description: string;
  /** The name that opens this view from the composer, without its `/`. A panel with none is only ever opened by the thing it belongs to. */
  command?: string;
  icon: LucideIcon;
  badge?: number;
  render: () => ReactNode;
};

/** An entry in the picker and the add menu: a panel to open, or an action that creates one. */
export type DockLauncher = { id: string; title: string; description: string; command: string; icon: LucideIcon; disabled?: boolean; open: () => void };

export type DockTab = { id: string; title: string; icon: LucideIcon; badge?: number };

/** The add menu is an `openMenu` value like any other, so the dock can tell when it is over a page. */
export const ADD_TAB_MENU = "dock-add";

/** What the bar says it is searching, which only the registry knows the name of. */
export function findLabel(target: FindTarget, panels: DockPanel[]): string {
  switch (target.kind) {
    case "browser": return "page";
    case "terminal": return "terminal";
    case "review": return "review";
    case "panel": return panels.find((panel) => panel.id === target.panel)?.title.toLowerCase() ?? "panel";
    case "thread": return "thread";
  }
}

export function unreviewedFileCount(diff: DiffState) {
  return diff.result?.status === "available" ? diff.result.files.filter((file) => !diff.viewed[file.path]).length : 0;
}

export type DockRegistry = { panels: DockPanel[]; launchers: DockLauncher[] };

export function buildDock({ workspace, inspectedSubagent, workingSubagents, unreviewedFiles, onInspectSubagent, onCloseInspector, onOpenPanel, onAddSideChat }: {
  workspace: Workspace;
  inspectedSubagent: Workspace["subagents"][number] | undefined;
  workingSubagents: number;
  unreviewedFiles: number;
  onInspectSubagent: (id: string) => void;
  onCloseInspector: () => void;
  onOpenPanel: (id: string) => void;
  onAddSideChat: () => void;
}): DockRegistry {
  /** The bar points at one view at a time, and a review only ever counts a search that names it. */
  const reviewFind = workspace.find?.target.kind === "review" ? workspace.find : null;
  const searchedPanel = workspace.find?.target.kind === "panel" ? workspace.find.target.panel : null;
  /** The searcher reads what a panel drew, so every view the tab can show draws whole while it reads. */
  const findingAgents = searchedPanel === "agents";

  const panels: DockPanel[] = [
    {
      id: "agents",
      title: "Subagents",
      description: "View work delegated from this task",
      command: "subagents",
      icon: Bot,
      badge: workingSubagents,
      render: () => (inspectedSubagent
        ? <SubagentInspector subagent={inspectedSubagent} finding={findingAgents} onClose={onCloseInspector} />
        : <AgentsPanel subagents={workspace.subagents} finding={findingAgents} onSelect={onInspectSubagent} />),
    },
    {
      id: "workflow",
      title: workspace.inspectedWorkflow?.name ?? "Workflow",
      description: "Follow a dynamic workflow the run is driving",
      icon: Boxes,
      render: () => (workspace.inspectedWorkflow
        ? <WorkflowPanel workflow={workspace.inspectedWorkflow} onStop={workspace.actions.stopBackgroundProcess} />
        : <p className="session-empty">This workflow is no longer running.</p>),
    },
    {
      id: DIFF_PANEL,
      title: "Changes",
      description: "Review the diff and comment on it",
      command: "diff",
      icon: FileDiff,
      badge: unreviewedFiles,
      render: () => (
        <DiffPanel
          /** Per thread, so a selection or a half-typed note never carries into another thread's review. */
          key={workspace.currentTask?.id ?? "draft"}
          diff={workspace.diff}
          {...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {})}
          openMenu={workspace.openMenu}
          onSetOpenMenu={workspace.actions.setOpenMenu}
          find={reviewFind}
          onFindResults={(results) => { if (reviewFind) void workspace.actions.reportFind(reviewFind.target, results); }}
          onSetRange={workspace.actions.setDiffRange}
          onSetCollapsed={workspace.actions.setDiffCollapsed}
          onSetViewed={workspace.actions.setDiffViewed}
          onSetSplit={workspace.actions.setDiffSplit}
          onRefresh={workspace.actions.refreshDiff}
          onOpenFile={(path) => void workspace.dispatch({ type: "file.open", path })}
          annotations={workspace.annotations}
          onComment={(quote, note, anchor) => void workspace.dispatch({ type: "annotation.add", quote, note, anchor })}
          onEditComment={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", annotationId, note })}
          onRemoveComment={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
        />
      ),
    },
    {
      id: "automation",
      title: "Automation",
      description: "Edit the schedule that repeats this task",
      command: "automation",
      icon: AlarmClock,
      render: () => (
        <AutomationPanel
          automation={workspace.automation}
          lastFoundAt={workspace.lastFoundAt}
          lastChecked={workspace.lastChecked}
          onUpdate={(patch) => void workspace.actions.updateAutomation(patch)}
          onDelete={() => void workspace.actions.deleteAutomation()}
          onRunNow={() => void workspace.actions.runAutomationNow()}
        />
      ),
    },
  ];

  /** One click opens the thing itself: a launcher makes a tab rather than a panel that holds tabs. */
  const launchers: DockLauncher[] = [
    ...panels.flatMap(({ id, title, description, command, icon }) => command ? [{ id, title, description, command, icon, open: () => onOpenPanel(id) }] : []),
    { id: "browser", title: "Browser", description: "Browse in one session the whole app shares", command: "browser", icon: Globe, open: () => void workspace.actions.newBrowserTab() },
    { id: "terminal", title: "Terminal", description: "Run a shell here and let Claude read what it prints", command: "terminal", icon: SquareTerminal, disabled: !workspace.currentFolder, open: () => void workspace.actions.openTerminal() },
    { id: "side-chat", title: "Side chat", description: "Start a focused conversation from this task", command: "side", icon: GitFork, disabled: !workspace.currentTask, open: onAddSideChat },
  ];

  return { panels, launchers };
}
