import type { IconType } from "react-icons";
import { LuAlarmClock as AlarmClock, LuBot as Bot, LuBoxes as Boxes, LuFileDiff as FileDiff, LuGitFork as GitFork, LuGlobe as Globe, LuLayoutGrid as LayoutGrid, LuSquareTerminal as SquareTerminal } from "react-icons/lu";
import { CoordinatorOverview } from "./Coordination";
import { AutomationPanel } from "./AutomationPanel";
import { DiffPanel } from "./DiffPanel";
import { AgentsPanel } from "./SubagentList";
import { SubagentInspector } from "./SubagentInspector";
import { WorkflowPanel } from "./WorkflowPanel";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { AUTOMATION_PANEL, DIFF_PANEL, OVERVIEW_PANEL } from "../../application/workspace-reducer";
import { overviewGroups } from "../../application/coordination";
import { isCoordinator } from "../../domain/coordination";
import { engineLabel } from "../../domain/agent-engine";
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
  icon: IconType;
  badge?: number;
  /** The badge counts what is waiting on the user rather than what is going on. */
  attention?: boolean;
  /** A tab the dock keeps for as long as it applies, so it has no close button. */
  pinned?: boolean;
  render: () => ReactNode;
};

/** An entry in the picker and the add menu: a panel to open, or an action that creates one. */
export type DockLauncher = { id: string; title: string; description: string; command: string; icon: IconType; disabled?: boolean; open: () => void };

export type DockTab = { id: string; title: string; icon: IconType; badge?: number; attention?: boolean; pinned?: boolean; unread?: boolean };

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

  const { subagents: feedsSubagents, workflows: feedsWorkflows } = workspace.capabilities;
  /** A coordinator's review and schedule can be about one of its thread tabs rather than itself. */
  const reviewed = workspace.threadTabs.find((tab) => tab.id === workspace.reviewSubject);
  const scheduled = workspace.threadTabs.find((tab) => tab.id === workspace.automationSubject);
  const reviewedEnvironment = reviewed ? reviewed.environment : workspace.environment;
  const reviewedWorkspaceId = reviewed ? reviewed.workspaceId : workspace.workspaceId;

  const needsYou = overviewGroups(workspace.coordination.members).needs.length;

  const panels: DockPanel[] = [
    ...(isCoordinator(workspace.currentThread) ? [{
      id: OVERVIEW_PANEL,
      title: "Overview",
      description: "Follow the threads working under this coordinator",
      icon: LayoutGrid,
      badge: needsYou,
      attention: true,
      pinned: true,
      render: () => (
        <CoordinatorOverview
          members={workspace.coordination.members}
          worktreeGroups={workspace.worktreeGroups}
          folds={workspace.overviewFolds}
          onSetFold={(group, change) => { if (workspace.currentThread) void workspace.actions.setOverviewGroup(workspace.currentThread.id, group, change); }}
          onSelect={workspace.actions.selectThread}
        />
      ),
    }] : []),
    ...(feedsSubagents ? [{
      id: "agents",
      title: "Subagents",
      description: "View work delegated from this task",
      command: "subagents",
      icon: Bot,
      badge: workingSubagents,
      render: () => (inspectedSubagent
        ? <SubagentInspector subagent={inspectedSubagent} finding={findingAgents} onClose={onCloseInspector} onStop={workspace.actions.stopBackgroundProcess} />
        : <AgentsPanel
            subagents={workspace.subagents}
            groups={workspace.subagentGroups}
            finding={findingAgents}
            onSelect={onInspectSubagent}
            onSetGroup={(group, open) => void workspace.actions.setSubagentGroup(group, open)}
          />),
    }] : []),
    ...(feedsWorkflows ? [{
      id: "workflow",
      title: workspace.inspectedWorkflow?.name ?? "Workflow",
      description: "Follow a dynamic workflow the run is driving",
      icon: Boxes,
      render: () => (workspace.inspectedWorkflow
        ? <WorkflowPanel workflow={workspace.inspectedWorkflow} onStop={workspace.actions.stopBackgroundProcess} />
        : <p className="session-empty">This workflow is no longer running.</p>),
    }] : []),
    {
      id: DIFF_PANEL,
      title: reviewed ? `Changes · ${reviewed.title}` : "Changes",
      description: "Review the diff and comment on it",
      command: "diff",
      icon: FileDiff,
      badge: unreviewedFiles,
      render: () => (
        <DiffPanel
          /** Per thread, so a selection or a half-typed note never carries into another thread's review. */
          key={reviewed?.id ?? workspace.currentThread?.id ?? "draft"}
          diff={workspace.diff}
          workspaceId={workspace.diff.workspaceId ?? reviewedWorkspaceId}
          currentBranch={reviewedEnvironment?.status === "available" && (!workspace.diff.workspaceId || workspace.diff.workspaceId === reviewedWorkspaceId) ? reviewedEnvironment.branch : null}
          openMenu={workspace.openMenu}
          onSetOpenMenu={workspace.actions.setOpenMenu}
          find={reviewFind}
          onFindResults={(results) => { if (reviewFind) void workspace.actions.reportFind(reviewFind.target, results); }}
          onSetRange={workspace.actions.setDiffRange}
          onSetMode={workspace.actions.setDiffMode}
          onSetCollapsed={workspace.actions.setDiffCollapsed}
          onSetViewed={workspace.actions.setDiffViewed}
          onSetSplit={workspace.actions.setDiffSplit}
          onSetIgnoreWhitespace={workspace.actions.setDiffIgnoreWhitespace}
          onRefresh={workspace.actions.refreshDiff}
          onOpenFile={(path) => void workspace.dispatch({ type: "file.open", path, ...(reviewed ? { taskId: reviewed.id } : {}) })}
          annotations={reviewed ? reviewed.annotations : workspace.annotations}
          onComment={(quote, note, anchor) => void workspace.dispatch({ type: "annotation.add", quote, note, anchor, ...(reviewed ? { taskId: reviewed.id } : {}) })}
          onEditComment={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", annotationId, note, ...(reviewed ? { taskId: reviewed.id } : {}) })}
          onRemoveComment={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId, ...(reviewed ? { taskId: reviewed.id } : {}) })}
        />
      ),
    },
    {
      id: AUTOMATION_PANEL,
      title: scheduled ? `Automation · ${scheduled.title}` : "Automation",
      description: "Edit the schedule that repeats this task",
      command: "automation",
      icon: AlarmClock,
      render: () => (
        <AutomationPanel
          automation={scheduled ? scheduled.automation : workspace.automation}
          engineLabel={scheduled ? engineLabel(scheduled.thread.engine) : workspace.engineLabel}
          lastFoundAt={scheduled ? scheduled.thread.lastFindingAt ?? null : workspace.lastFoundAt}
          lastChecked={scheduled ? scheduled.thread.lastChecked ?? null : workspace.lastChecked}
          onUpdate={(patch) => void workspace.actions.updateAutomation(patch, scheduled?.id)}
          onDelete={() => void workspace.actions.deleteAutomation(scheduled?.id)}
          onRunNow={() => void workspace.actions.runAutomationNow(scheduled?.id)}
        />
      ),
    },
  ];

  /** One click opens the thing itself: a launcher makes a tab rather than a panel that holds tabs. */
  const launchers: DockLauncher[] = [
    ...panels.flatMap(({ id, title, description, command, icon }) => command ? [{ id, title, description, command, icon, disabled: !workspace.commandControls.available({ type: "view.open-dock-panel", panel: id }), open: () => onOpenPanel(id) }] : []),
    { id: "browser", title: "Browser", description: "Browse in one session the whole app shares", command: "browser", icon: Globe, disabled: !workspace.commandControls.available({ type: "browser.new-tab" }), open: () => void workspace.actions.newBrowserTab() },
    { id: "terminal", title: "Terminal", description: `Run a shell here and let ${workspace.engineLabel} read what it prints`, command: "terminal", icon: SquareTerminal, disabled: !workspace.currentFolder || !workspace.commandControls.available({ type: "terminal.open" }), open: () => void workspace.actions.openTerminal() },
    { id: "side-chat", title: "Side chat", description: "Start a focused conversation from this task", command: "side", icon: GitFork, disabled: !workspace.currentThread || !workspace.commandControls.available({ type: "side-chat.open", chatId: "new" }), open: onAddSideChat },
  ];

  return { panels, launchers };
}
