import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlarmClock, Bot, Boxes, FileDiff, GitFork, Globe, Maximize2, Minimize2, Plus, SquareTerminal, X, type LucideIcon } from "lucide-react";
import { ApprovalCard } from "./components/ApprovalCard";
import { AutomationPanel } from "./components/AutomationPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { DiffPanel } from "./components/DiffPanel";
import { MessageLinkProvider, type MessageLinkActions } from "./components/MarkdownMessage";
import { DiagramViewerHost } from "./components/MermaidBlock";
import { FindBar } from "./components/FindBar";
import { ProjectEditDialog } from "./components/ProjectEditDialog";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { SessionPanel } from "./components/SessionPanel";
import { AgentsPanel } from "./components/SubagentList";
import { ThreadModeSwitch, ThreadStartOptions } from "./components/ThreadStartOptions";
import { SideChat } from "./components/SideChat";
import { SubagentInspector } from "./components/SubagentInspector";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { TaskComposer } from "./components/TaskComposer";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";
import { useFileDrop, useRefusedStrayDrops } from "./file-drop";
import { attachDroppedFiles } from "./dropped-files";
import { browserTabTitle } from "../domain/browser";
import { DIFF_PANEL } from "../application/workspace-reducer";
import { sentPrompts } from "../domain/task";
import { moveListFocus, useDismissibleLayer } from "./focus";

/**
 * A view in the right dock that there is only ever one of. Pages, shells and side chats are tabs of
 * their own instead: they are opened by a launcher below and drawn from the workspace's own records.
 */
type DockPanel = {
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
type DockLauncher = { id: string; title: string; description: string; command: string; icon: LucideIcon; disabled?: boolean; open: () => void };

type DockTab = { id: string; title: string; icon: LucideIcon; badge?: number };

/** The add menu is an `openMenu` value like any other, so the dock can tell when it is over a page. */
const ADD_TAB_MENU = "dock-add";

/** Everything the sidebar draws and every command its rows dispatch, kept out of the shell below. */
function Sidebar({ workspace, open, settingsVisible, onOpenSettings }: {
  workspace: ReturnType<typeof useTaskWorkspace>;
  open: boolean;
  settingsVisible: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <ProjectSidebar
      open={open}
      inactive={settingsVisible}
      projects={workspace.projects}
      orderedTasks={workspace.orderedTasks}
      recentTasks={workspace.recentTasks}
      currentId={workspace.currentTask?.id ?? null}
      draftProjectId={workspace.currentProject?.id ?? null}
      expandedProjects={workspace.expandedProjects}
      runningTaskIds={workspace.runningTaskIds}
      blockedTaskIds={workspace.blockedTaskIds}
      schedules={workspace.schedules}
      worktreeTaskIds={workspace.worktreeTaskIds}
      worktreeGroups={workspace.worktreeGroups}
      activityTasks={workspace.activityTasks}
      mode={workspace.sidebarMode}
      sections={workspace.sections}
      openMenu={workspace.openMenu}
      settingsOpen={settingsVisible}
      canGoBack={workspace.canGoBack}
      canGoForward={workspace.canGoForward}
      onGoBack={() => void workspace.actions.goBack()}
      onGoForward={() => void workspace.actions.goForward()}
      onNewTask={workspace.actions.newTask}
      onOpenFolder={workspace.actions.openFolder}
      onToggleProject={workspace.actions.toggleProject}
      onRenameProject={(projectId, name) => void workspace.actions.editProject(projectId, { name })}
      onEditProject={workspace.actions.editProjectOpen}
      onRemoveProject={workspace.actions.removeProject}
      onMoveProject={workspace.actions.moveProject}
      onSetMode={workspace.actions.setSidebarMode}
      onSetSectionOpen={workspace.actions.setSectionOpen}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      onSelectTask={workspace.actions.selectTask}
      onArchiveTask={workspace.actions.archiveTask}
      onDismissTask={workspace.actions.dismissTask}
      onDismissAll={workspace.actions.dismissAllTasks}
      onRenameTask={workspace.actions.renameTask}
      onMoveTask={workspace.actions.moveTask}
      onForkTask={workspace.actions.forkTask}
      onOpenSettings={onOpenSettings}
    />
  );
}

export function App() {
  const workspace = useTaskWorkspace();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null);
  const sidebarOpen = workspace.sidebarOpen;
  const settingsVisible = workspace.settingsOpen;
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  /** The tab counts what is still to read, so ticking files off empties it the way working down a list should. */
  const unreviewedFiles = workspace.diff.result?.status === "available"
    ? workspace.diff.result.files.filter((file) => !workspace.diff.viewed[file.path]).length
    : 0;
  const rightDockOpen = workspace.dockOpen;
  const rightDockExpanded = rightDockOpen && workspace.dockExpanded;
  const activeRightTab = workspace.dockTab;
  const addMenuOpen = workspace.openMenu === ADD_TAB_MENU;
  const addMenu = useRef<HTMLDivElement>(null);
  const addMenuTrigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(addMenuOpen, [addMenu], () => workspace.actions.setOpenMenu(null), addMenuTrigger);
  /** The right dock takes the same space, so it hides the panel without discarding the choice. */
  const sessionPanelVisible = workspace.sessionPanelOpen && !rightDockOpen;
  const find = workspace.find;
  /** One bar, drawn wherever what it searches is: above the transcript, the page, or the shell. */
  const findBar = find ? (
    <FindBar
      find={find}
      label={find.target.kind === "browser" ? "page" : find.target.kind === "terminal" ? "terminal" : "thread"}
      onQuery={workspace.actions.setFindQuery}
      onStep={workspace.actions.stepFind}
      onClose={workspace.actions.closeFind}
    />
  ) : null;
  const inspectedSubagent = workspace.subagents.find((subagent) => subagent.id === selectedSubagent);
  const inspectedWorkflow = workspace.inspectedWorkflow;

  function addSideChat() {
    void workspace.dispatch({ type: "side-chat.open", chatId: crypto.randomUUID() });
  }

  /** A selection handed to the side chat lands in the one already open, or opens one to take it. */
  function annotateToSideChat(quote: string) {
    const existing = workspace.sideChats[0];
    if (existing) {
      void workspace.dispatch({ type: "view.select-dock-tab", tab: existing.id });
      void workspace.dispatch({ type: "view.set-dock-open", open: true });
      void workspace.dispatch({ type: "annotation.add", taskId: existing.id, quote });
      return;
    }
    const chatId = crypto.randomUUID();
    void workspace.dispatch({ type: "side-chat.open", chatId });
    void workspace.dispatch({ type: "annotation.add", taskId: chatId, quote });
  }

  function openRightTab(id: string) {
    void workspace.actions.openDockPanel(id);
  }

  /** The strip keeps the keyboard when a tab goes, so closing several in a row never needs the mouse. */
  async function closeRightTab(id: string) {
    if (workspace.dockPanels.includes(id)) await workspace.actions.closeDockPanel(id);
    else if (workspace.browserTabs.some((tab) => tab.id === id)) await workspace.actions.closeBrowserTab(id);
    else if (workspace.terminals.some((terminal) => terminal.id === id)) await workspace.actions.closeTerminal(id);
    else await workspace.dispatch({ type: "side-chat.close", chatId: id });
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>('.right-dock-tab.active [role="tab"]') ?? addMenuTrigger.current)?.focus();
    });
  }

  function closeSubagentInspector() {
    setSelectedSubagent(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.agents-panel input, .agents-panel button')?.focus());
  }

  function openSettings() {
    void workspace.actions.setSettingsOpen(true);
  }

  function closeSettings() {
    void workspace.actions.setSettingsOpen(false);
  }

  function resizeRightDock(target: HTMLElement, clientX: number) {
    const panel = target.parentElement;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    const bounds = parent.getBoundingClientRect();
    parent.style.setProperty("--right-dock-width", `${Math.min(bounds.width - 320, Math.max(320, bounds.right - clientX))}px`);
  }

  useEffect(() => {
    if (selectedSubagent && !workspace.subagents.some((subagent) => subagent.id === selectedSubagent)) setSelectedSubagent(null);
  }, [workspace.currentTask?.id, workspace.subagents, selectedSubagent]);

  useEffect(() => {
    setSelectedSubagent(null);
  }, [workspace.currentTask?.id]);

  useEffect(() => {
    if (!workspace.dockPanels.includes("agents")) setSelectedSubagent(null);
  }, [workspace.dockPanels]);

  useEffect(() => {
    /** Esc serves whatever is nearest: an overlay claims it first, then a menu, the find bar, and last the run. */
    function handleKeys(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (workspace.openMenu !== null) workspace.actions.setOpenMenu(null);
      else if (workspace.settingsOpen) void workspace.actions.setSettingsOpen(false);
      else if (workspace.find) workspace.actions.closeFind();
      else void workspace.actions.cancelRun();
    }
    window.addEventListener("keydown", handleKeys);
    return () => {
      window.removeEventListener("keydown", handleKeys);
    };
  }, [workspace.actions, workspace.openMenu, workspace.settingsOpen, workspace.find]);

  const inspectSubagent = useCallback((id: string) => {
    setSelectedSubagent(id);
    void workspace.actions.inspectSubagent(id);
  }, [workspace.actions]);

  const openWorkflow = useCallback((id: string) => {
    void workspace.actions.openWorkflow(id);
  }, [workspace.actions]);

  const dockPanels: DockPanel[] = [
    {
      id: "agents",
      title: "Subagents",
      description: "View work delegated from this task",
      command: "subagents",
      icon: Bot,
      badge: workingSubagents,
      render: () => (inspectedSubagent
        ? <SubagentInspector subagent={inspectedSubagent} onClose={closeSubagentInspector} />
        : <AgentsPanel subagents={workspace.subagents} onSelect={inspectSubagent} />),
    },
    {
      id: "workflow",
      title: inspectedWorkflow?.name ?? "Workflow",
      description: "Follow a dynamic workflow the run is driving",
      icon: Boxes,
      render: () => (inspectedWorkflow
        ? <WorkflowPanel workflow={inspectedWorkflow} onStop={workspace.actions.stopBackgroundProcess} />
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
          onSetRange={workspace.actions.setDiffRange}
          onSetCollapsed={workspace.actions.setDiffCollapsed}
          onSetViewed={workspace.actions.setDiffViewed}
          onSetSplit={workspace.actions.setDiffSplit}
          onRefresh={workspace.actions.refreshDiff}
          onOpenFile={(path) => void workspace.dispatch({ type: "file.open", path })}
          onComment={(quote, note) => void workspace.dispatch({ type: "annotation.add", quote, ...(note ? { note } : {}) })}
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
  const dockLaunchers: DockLauncher[] = [
    ...dockPanels.flatMap(({ id, title, description, command, icon }) => command ? [{ id, title, description, command, icon, open: () => openRightTab(id) }] : []),
    { id: "browser", title: "Browser", description: "Browse in one session the whole app shares", command: "browser", icon: Globe, open: () => void workspace.actions.newBrowserTab() },
    { id: "terminal", title: "Terminal", description: "Run a shell here and let Claude read what it prints", command: "terminal", icon: SquareTerminal, disabled: !workspace.currentFolder, open: () => void workspace.actions.openTerminal() },
    { id: "side-chat", title: "Side chat", description: "Start a focused conversation from this task", command: "side", icon: GitFork, disabled: !workspace.currentTask, open: addSideChat },
  ];

  /** The `/` menu is the dock registry, so a view added there is reachable from the composer too. */
  const composerActions = dockLaunchers
    .filter((launcher) => !launcher.disabled)
    .map(({ command, description, open }) => ({ name: command, description, run: open }));

  /** Which dock tab was last asked to take the keyboard, as the count the view watches. */
  const dockFocus = workspace.dockFocus;
  const focusTokenFor = (tab: string) => dockFocus?.tab === tab ? dockFocus.count : 0;

  /** A page the app handed the keyboard to is holding it on purpose, and must not have it taken back. */
  const pageTookKeys = dockFocus !== null && dockFocus.tab === activeRightTab && workspace.browserTabs.some((tab) => tab.id === dockFocus.tab && tab.url);

  const browserTab = workspace.browserTabs.find((tab) => tab.id === activeRightTab);
  const shownTerminal = workspace.terminals.find((terminal) => terminal.id === activeRightTab);

  const dockTabs: DockTab[] = [
    ...dockPanels.filter((panel) => workspace.dockPanels.includes(panel.id)).map(({ id, title, icon, badge }) => ({ id, title, icon, badge })),
    ...workspace.browserTabs.map((tab) => ({ id: tab.id, title: browserTabTitle(tab), icon: Globe })),
    ...workspace.terminals.map((terminal) => ({ id: terminal.id, title: terminal.title, icon: SquareTerminal })),
    ...workspace.sideChats.map((chat) => ({ id: chat.id, title: chat.title, icon: GitFork })),
  ];

  /** Held still, so a link in a settled message is not a fresh handler on every render of the shell. */
  const dispatchRef = useRef(workspace.dispatch);
  dispatchRef.current = workspace.dispatch;

  /**
   * A view taken off screen leaves the caret nowhere a keystroke can reach, and a window with no
   * caret answers no typing at all. Whenever one goes the composer takes the keyboard back, unless a
   * page or the settings sheet is the one holding it.
   */
  useEffect(() => {
    if (pageTookKeys || settingsVisible) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const stranded = !active || active === document.body || !active.isConnected || active.closest("[hidden],[inert]") !== null;
      if (stranded) void dispatchRef.current({ type: "view.focus-composer" });
    });
    return () => cancelAnimationFrame(frame);
  }, [rightDockOpen, sidebarOpen, settingsVisible, pageTookKeys, dockFocus, activeRightTab]);

  /** A file dropped anywhere in the window that is not a surface of its own belongs to this thread. */
  const workspaceDrop = useFileDrop(useCallback((files: File[]) => {
    void attachDroppedFiles(files, undefined, dispatchRef.current);
  }, []));

  useRefusedStrayDrops();

  const messageLinks = useMemo<MessageLinkActions>(() => ({
    selectTask: (taskId: string) => void dispatchRef.current({ type: "task.select", taskId }),
    openFile: (path: string, line: number | null) => void dispatchRef.current({ type: "file.open", path, line: line ?? undefined }),
    openUrlInApp: (url: string) => void dispatchRef.current({ type: "browser.open", url, newTab: true }),
  }), []);

  return (
    <MessageLinkProvider actions={messageLinks}>
    <DiagramViewerHost>
    <main className="app-shell">
      <Sidebar workspace={workspace} open={sidebarOpen} settingsVisible={settingsVisible} onOpenSettings={openSettings} />
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => void workspace.actions.setSidebarOpen(false)} />}

      <section
        className={`workspace ${sessionPanelVisible ? "summary-open" : ""} ${rightDockOpen ? "dock-open" : ""} ${rightDockExpanded ? "dock-full" : ""} ${workspaceDrop.over ? "dropping" : ""}`}
        inert={settingsVisible}
        {...workspaceDrop.props}
      >
        <WorkspaceHeader
          currentTask={workspace.currentTask}
          folder={workspace.folder}
          folderLabel={workspace.folderLabel}
          sidebarOpen={sidebarOpen}
          sessionPanelOpen={sessionPanelVisible}
          rightDockOpen={rightDockOpen}
          workingSubagents={workingSubagents}
          openMenu={workspace.openMenu}
          canOpenFolder={Boolean(workspace.folder) && workspace.location?.kind !== "creating"}
          onSetOpenMenu={workspace.actions.setOpenMenu}
          onOpenInApp={(appId) => void workspace.actions.openFolderInApp(appId)}
          onToggleSidebar={() => void workspace.actions.setSidebarOpen(!sidebarOpen)}
          onToggleSessionPanel={() => {
            void workspace.actions.setDockOpen(false);
            void workspace.actions.setSessionPanelOpen(!sessionPanelVisible);
          }}
          onToggleRightDock={() => {
            if (!rightDockOpen) setSelectedSubagent(null);
            void workspace.actions.setDockOpen(!rightDockOpen);
          }}
        />
        {(workspace.storageError || workspace.actionError) && (
          <div className="storage-error" role="alert">
            <span>{workspace.storageError || workspace.actionError}</span>
            {!workspace.storageError && (
              <button type="button" aria-label="Dismiss error" onClick={() => void workspace.dispatch({ type: "view.dismiss-action-error" })}>
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <div className="work-area">
          {find?.target.kind === "transcript" && findBar}
          {!workspace.currentTask && (
            <ThreadModeSwitch
              projects={workspace.projects}
              projectId={workspace.currentProject?.id ?? null}
              onSelectProject={workspace.actions.newTask}
            />
          )}
          <div className="conversation" ref={transcriptRef}>
            <ConversationTimeline
              find={find?.target.kind === "transcript" ? find : null}
              currentTask={workspace.currentTask}
              folder={workspace.folder}
              status={workspace.status}
              compacting={workspace.compacting}
              waitingOn={workspace.waitingOn}
              streamingTail={workspace.streamingTail}
              readingPoint={workspace.readingPoint}
              onReadingPointMove={(point) => {
                if (workspace.currentTask) void workspace.dispatch({ type: "view.reading-point", taskId: workspace.currentTask.id, point });
              }}
              scrollContainerRef={transcriptRef}
              restored={workspace.restored}
              startOptions={!workspace.currentTask && (
                <ThreadStartOptions
                  projects={workspace.projects}
                  projectId={workspace.currentProject?.id ?? null}
                  {...(workspace.currentProject?.workspaceId ? { workspaceId: workspace.currentProject.workspaceId } : {})}
                  branch={workspace.draftBranch}
                  worktree={workspace.draftWorktree}
                  {...(workspace.draftWorktreeName ? { startsInWorktree: workspace.draftWorktreeName } : {})}
                  onSelectProject={workspace.actions.newTask}
                  onSelectBranch={workspace.actions.setBranch}
                  onSetWorktree={workspace.actions.setWorktree}
                />
              )}
              annotations={workspace.annotations}
              onAnnotateAdd={({ quote, note, anchor }) => void workspace.dispatch({ type: "annotation.add", quote, note, anchor })}
              onAnnotateNote={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", annotationId, note })}
              onAnnotateRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
              onAnnotateSide={annotateToSideChat}
            />
            {workspace.approval && <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />}
          </div>
        </div>

        {sessionPanelVisible && (
          <SessionPanel
            environment={workspace.environment}
            hasProject={Boolean(workspace.folder)}
            {...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {})}
            {...(workspace.currentTask ? { taskId: workspace.currentTask.id, location: workspace.location } : {})}
            runActive={workspace.runActive}
            openMenu={workspace.openMenu}
            onSetOpenMenu={workspace.actions.setOpenMenu}
            subagents={workspace.subagents}
            backgroundProcesses={workspace.backgroundProcesses}
            workflows={workspace.workflows}
            automationCount={workspace.automation ? 1 : 0}
            onSelect={(id) => {
              inspectSubagent(id);
              openRightTab("agents");
            }}
            onToggleChanges={workspace.actions.toggleDiff}
            onOpenAgents={() => openRightTab("agents")}
            onOpenAutomations={() => openRightTab("automation")}
            onOpenWorkflow={openWorkflow}
            onStopProcess={workspace.actions.stopBackgroundProcess}
            onCheckoutBranch={(branch, create) => void workspace.actions.checkoutBranch(branch, create)}
            onSetWorktree={(worktree) => {
              /** Only work that would otherwise be lost is worth stopping for; a clean worktree just goes. */
              const holding = workspace.environment?.status === "available" ? workspace.environment.files.length : 0;
              const question = worktree
                ? "Give this thread a worktree? It moves into a checkout of its own and works there from now on."
                : holding
                  ? `Return this thread to your project checkout? Its ${holding} uncommitted ${holding === 1 ? "change is" : "changes are"} committed first so nothing is lost, then the worktree is removed.`
                  : null;
              if (question === null || window.confirm(question)) void workspace.actions.setWorktree(worktree);
            }}
          />
        )}

        <aside className="right-dock" aria-label="Right panel" hidden={!rightDockOpen}>
            <div
              className="right-dock-resizer"
              role="separator"
              aria-label="Resize right panel"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeRightDock(event.currentTarget, event.clientX);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const panel = event.currentTarget.parentElement;
                if (panel) resizeRightDock(event.currentTarget, panel.getBoundingClientRect().left + (event.key === "ArrowLeft" ? -10 : 10));
              }}
            />
            <div className={`right-dock-tabs ${rightDockExpanded && !sidebarOpen ? "traffic-inset" : ""}`.trimEnd()}>
              <div role="tablist" aria-label="Right panel tabs">
                {dockTabs.map((tab) => (
                  <div className={`right-dock-tab ${activeRightTab === tab.id ? "active" : ""}`} key={tab.id}>
                    <button type="button" role="tab" aria-selected={activeRightTab === tab.id} onClick={() => void workspace.actions.selectDockTab(tab.id)}>
                      <tab.icon size={15} aria-hidden="true" /><span>{tab.title}</span>
                      {tab.badge ? <em>{tab.badge}</em> : null}
                    </button>
                    <button type="button" aria-label={`Close ${tab.title}`} onClick={() => closeRightTab(tab.id)}><X size={13} /></button>
                  </div>
                ))}
              </div>
              <div ref={addMenu} className={`right-dock-add ${addMenuOpen ? "open" : ""}`.trimEnd()} data-popover-menu>
                <button
                  ref={addMenuTrigger}
                  type="button"
                  aria-label="Add right panel tab"
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen}
                  onClick={() => workspace.actions.setOpenMenu(addMenuOpen ? null : ADD_TAB_MENU)}
                >
                  <Plus size={18} />
                </button>
                {addMenuOpen && (
                  <div role="menu" onKeyDown={moveListFocus}>
                    {dockLaunchers.map((launcher, index) => (
                      <button key={launcher.id} type="button" role="menuitem" autoFocus={index === 0} disabled={launcher.disabled} onClick={() => { workspace.actions.setOpenMenu(null); launcher.open(); }}>
                        <launcher.icon size={16} />{launcher.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="right-dock-hide"
                type="button"
                aria-label={`${rightDockExpanded ? "Restore" : "Expand"} right panel`}
                aria-pressed={rightDockExpanded}
                onClick={() => void workspace.actions.setDockExpanded(!rightDockExpanded)}
              >
                {rightDockExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button className="right-dock-hide" type="button" aria-label="Hide right panel" onClick={() => void workspace.actions.setDockOpen(false)}><X size={17} /></button>
            </div>
            <div className="right-dock-content">
              <div className="right-dock-picker" hidden={activeRightTab !== "home"} aria-label="Choose a right panel">
                <header>
                  <h2>Choose a panel</h2>
                  <p>Inspect delegated work or start a focused conversation.</p>
                </header>
                <div>
                  {dockLaunchers.map((launcher) => (
                    <button key={launcher.id} type="button" aria-label={`Open ${launcher.title} panel`} disabled={launcher.disabled} onClick={launcher.open}>
                      <launcher.icon size={19} aria-hidden="true" />
                      <span><strong>{launcher.title}</strong><small>{launcher.description}</small></span>
                    </button>
                  ))}
                </div>
              </div>
              {dockPanels.filter((panel) => workspace.dockPanels.includes(panel.id)).map((panel) => (
                <div key={panel.id} hidden={activeRightTab !== panel.id}>{panel.render()}</div>
              ))}
              {/** A page is a native view main draws over the panel, so only the one on top is ever drawn. */}
              {browserTab && (
                <div>
                  <BrowserPanel
                    tab={browserTab}
                    focusToken={focusTokenFor(browserTab.id)}
                    {...(find?.target.kind === "browser" && find.target.tabId === browserTab.id ? { find: findBar } : {})}
                    approval={workspace.browserApproval?.tabId === browserTab.id ? workspace.browserApproval : null}
                    onOpen={(url) => void workspace.actions.openBrowser(url, false, browserTab.id)}
                    onGo={(delta) => void workspace.actions.goInBrowser(delta, browserTab.id)}
                    onReload={() => void workspace.actions.reloadBrowser(browserTab.id)}
                    onDecide={(allow) => void workspace.actions.decideBrowser(allow)}
                  />
                </div>
              )}
              {shownTerminal && (
                <div>
                  <TerminalPanel
                    terminal={shownTerminal}
                    focusToken={focusTokenFor(shownTerminal.id)}
                    {...(find?.target.kind === "terminal" && find.target.terminalId === shownTerminal.id ? { find: findBar } : {})}
                    visible={rightDockOpen && !settingsVisible}
                    onInput={(terminalId, data) => void workspace.actions.sendToTerminal(terminalId, data)}
                    onResize={(terminalId, cols, rows) => void workspace.actions.resizeTerminal(terminalId, cols, rows)}
                  />
                </div>
              )}
              {workspace.currentTask && workspace.sideChats.map((chat) => (
                <div key={chat.id} hidden={activeRightTab !== chat.id}>
                  <SideChat
                    chat={chat}
                    focusToken={focusTokenFor(chat.id)}
                    source={workspace.currentTask!}
                    project={workspace.currentProject}
                    threads={workspace.threadHandlesFor(chat.id)}
                    onPrompt={(prompt) => void workspace.dispatch({ type: "view.set-prompt", taskId: chat.id, prompt })}
                    onAnnotateAdd={({ quote, note, anchor }) => void workspace.dispatch({ type: "annotation.add", taskId: chat.id, quote, note, anchor })}
                    onAnnotateNote={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", taskId: chat.id, annotationId, note })}
                    onAnnotateRecall={(annotations) => void workspace.dispatch({ type: "annotation.recall", taskId: chat.id, annotations })}
                    onAnnotateRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", taskId: chat.id, annotationId })}
                    onPasteAdd={(text) => void workspace.dispatch({ type: "paste.add", taskId: chat.id, text })}
                    onPasteRecall={(pastes) => void workspace.dispatch({ type: "paste.recall", taskId: chat.id, pastes })}
                    onPasteRemove={(pasteId) => void workspace.dispatch({ type: "paste.remove", taskId: chat.id, pasteId })}
                    onFilesAdd={(files) => void attachDroppedFiles(files, chat.id, dispatchRef.current)}
                    onFileRecall={(files) => void workspace.dispatch({ type: "file.recall", taskId: chat.id, files })}
                    onFileRemove={(fileId) => void workspace.dispatch({ type: "file.detach", taskId: chat.id, fileId })}
                    readingPoint={chat.readingPoint}
                    onReadingPointMove={(point) => void workspace.dispatch({ type: "view.reading-point", taskId: chat.id, point })}
                    onSend={(attachments, steer) => void workspace.dispatch({ type: "task.send", taskId: chat.id, attachments, steer })}
                    onCancel={() => void workspace.dispatch({ type: "run.cancel", taskId: chat.id })}
                    onDecide={(allow) => void workspace.dispatch({ type: "run.decide", allow, taskId: chat.id })}
                    onPolicyChange={(policy) => void workspace.dispatch({ type: "task.set-policy", taskId: chat.id, policy })}
                    onImageRemove={(imageId) => void workspace.dispatch({ type: "image.remove", taskId: chat.id, imageId })}
                    onModelChange={(model) => void workspace.dispatch({ type: "task.set-model", taskId: chat.id, model })}
                    onEffortChange={(effort) => void workspace.dispatch({ type: "task.set-effort", taskId: chat.id, effort })}
                    onSteerQueued={(messageId) => void workspace.dispatch({ type: "task.steer-queued", taskId: chat.id, messageId })}
                    onDropQueued={(messageId) => void workspace.dispatch({ type: "task.drop-queued", taskId: chat.id, messageId })}
                    onClose={() => closeRightTab(chat.id)}
                  />
                </div>
              ))}
            </div>
        </aside>

        <TaskComposer
          focusToken={workspace.composerFocus}
          images={workspace.images}
          onImageRemove={(imageId) => void workspace.dispatch({ type: "image.remove", imageId })}
          prompt={workspace.prompt}
          folder={workspace.folder}
          workspaceId={workspace.currentProject?.workspaceId}
          mode={workspace.policy}
          model={workspace.model}
          effort={workspace.effort}
          contextUsage={workspace.currentTask?.contextUsage}
          runActive={workspace.runActive}
          waiting={workspace.waitingOn !== null}
          queuedMessages={workspace.queuedMessages}
          annotations={workspace.annotations}
          pastes={workspace.pastes}
          files={workspace.files}
          history={sentPrompts(workspace.currentTask?.messages ?? [])}
          actions={composerActions}
          threads={workspace.threadHandles}
          onPromptChange={workspace.actions.setPrompt}
          onAnnotationRecall={(annotations) => void workspace.dispatch({ type: "annotation.recall", annotations })}
          onAnnotationRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
          onPasteAdd={(text) => void workspace.dispatch({ type: "paste.add", text })}
          onPasteRecall={(pastes) => void workspace.dispatch({ type: "paste.recall", pastes })}
          onPasteRemove={(pasteId) => void workspace.dispatch({ type: "paste.remove", pasteId })}
          onFilesAdd={(files) => void attachDroppedFiles(files, undefined, dispatchRef.current)}
          onFileRecall={(files) => void workspace.dispatch({ type: "file.recall", files })}
          onFileRemove={(fileId) => void workspace.dispatch({ type: "file.detach", fileId })}
          onModeChange={workspace.actions.setPolicy}
          onModelChange={workspace.actions.setModel}
          onEffortChange={workspace.actions.setEffort}
          onSend={(attachments, steer) => void workspace.actions.sendPrompt(attachments, steer)}
          onSteerQueued={workspace.actions.steerQueued}
          onDropQueued={workspace.actions.dropQueued}
          onCancel={workspace.actions.cancelRun}
        />
        {workspaceDrop.over && <p className="drop-hint" role="status">Drop to attach</p>}
      </section>
      {workspace.projectEditor && (
        <ProjectEditDialog
          editor={workspace.projectEditor}
          onSave={(edit) => void workspace.actions.editProject(workspace.projectEditor!.project.id, edit)}
          onClose={() => void workspace.actions.editProjectClose()}
        />
      )}
      {settingsVisible && (
        <SettingsPanel
          onClose={closeSettings}
          initialSection={workspace.computerUseSetup ? "computer-use" : "general"}
          archivedTasks={workspace.archivedTasks}
          theme={workspace.theme}
          themeMode={workspace.themeMode}
          uiFont={workspace.uiFont}
          monoFont={workspace.monoFont}
          readingSize={workspace.readingSize}
          terminalSize={workspace.terminalSize}
          allowedOrigins={workspace.browserOrigins}
          plainEnglish={workspace.plainEnglish}
          notifications={workspace.notifications}
          shortcuts={workspace.shortcuts}
          capturingShortcut={workspace.capturingShortcut}
          onSetThemeFamily={(family) => void workspace.actions.setThemeFamily(family)}
          onSetThemeMode={(mode) => void workspace.actions.setThemeMode(mode)}
          onSetUiFont={(font) => void workspace.actions.setUiFont(font)}
          onSetMonoFont={(font) => void workspace.actions.setMonoFont(font)}
          onSetReadingSize={(size) => void workspace.actions.setReadingSize(size)}
          onSetTerminalSize={(size) => void workspace.actions.setTerminalSize(size)}
          onSetPlainEnglish={(enabled) => void workspace.actions.setPlainEnglish(enabled)}
          onSetNotifications={(enabled) => void workspace.actions.setNotifications(enabled)}
          onRestoreTask={workspace.actions.restoreTask}
          onClearArchive={workspace.actions.clearArchive}
          onClearBrowserData={() => void workspace.actions.clearBrowserData()}
          onCaptureShortcut={(action) => void workspace.actions.captureShortcut(action)}
          onSetShortcut={(action, binding) => void workspace.actions.setShortcut(action, binding)}
          onResetShortcuts={() => void workspace.actions.resetShortcuts()}
        />
      )}
    </main>
    </DiagramViewerHost>
    </MessageLinkProvider>
  );
}
