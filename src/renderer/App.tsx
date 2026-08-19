import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlarmClock, Bot, GitFork, Plus, X, type LucideIcon } from "lucide-react";
import { ApprovalCard } from "./components/ApprovalCard";
import { AutomationPanel } from "./components/AutomationPanel";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { AgentsPanel, SessionPanel } from "./components/SessionPanel";
import { SideChat } from "./components/SideChat";
import { SubagentInspector } from "./components/SubagentInspector";
import { TaskComposer } from "./components/TaskComposer";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";

/** A view in the right dock. Every right dock view is a tab, so adding one means adding an entry to `dockPanels`. */
type DockPanel = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  badge?: number;
  /** Runs when the tab closes, for view state the panel owns outside the workspace. */
  onClose?: () => void;
  render: () => ReactNode;
};

/** An entry in the picker and the add menu: a panel to open, or an action that creates one. */
type DockLauncher = { id: string; title: string; description: string; icon: LucideIcon; disabled?: boolean; open: () => void };

type DockTab = { id: string; title: string; icon: LucideIcon; badge?: number };

export function App() {
  const workspace = useTaskWorkspace();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState("home");
  const [openPanels, setOpenPanels] = useState<string[]>([]);
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsVisible = settingsOpen || workspace.computerUseSetup;
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  /** The right dock takes the same space, so it hides the panel without discarding the choice. */
  const sessionPanelVisible = workspace.sessionPanelOpen && !rightDockOpen;
  const inspectedSubagent = workspace.subagents.find((subagent) => subagent.id === selectedSubagent);

  function addSideChat() {
    const chatId = crypto.randomUUID();
    void workspace.dispatch({ type: "side-chat.open", chatId });
    setActiveRightTab(chatId);
    setRightDockOpen(true);
  }

  function openRightTab(id: string) {
    setOpenPanels((panels) => (panels.includes(id) ? panels : [...panels, id]));
    setActiveRightTab(id);
    setRightDockOpen(true);
  }

  function closeRightTab(id: string) {
    const index = dockTabs.findIndex((tab) => tab.id === id);
    if (openPanels.includes(id)) setOpenPanels((panels) => panels.filter((panel) => panel !== id));
    else void workspace.dispatch({ type: "side-chat.close", chatId: id });
    dockPanels.find((panel) => panel.id === id)?.onClose?.();
    if (activeRightTab === id) setActiveRightTab(dockTabs[index - 1]?.id ?? dockTabs[index + 1]?.id ?? "home");
  }

  function openSettings() {
    setSettingsOpen(true);
    setSidebarOpen(false);
    setRightDockOpen(false);
  }

  function closeSettings() {
    setSettingsOpen(false);
    workspace.actions.dismissComputerUseSetup();
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
    setActiveRightTab("home");
    setOpenPanels([]);
    setSelectedSubagent(null);
  }, [workspace.currentTask?.id]);

  useEffect(() => {
    function dismissMenu(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest("[data-popover-menu]")) workspace.actions.setOpenMenu(null);
    }
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape") workspace.actions.setOpenMenu(null);
      if (!event.metaKey || event.ctrlKey || event.altKey || (event.key !== "[" && event.key !== "]")) return;
      event.preventDefault();
      void (event.key === "[" ? workspace.actions.goBack() : workspace.actions.goForward());
    }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", handleKeys);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", handleKeys);
    };
  }, [workspace.actions]);

  const dockPanels: DockPanel[] = [
    {
      id: "agents",
      title: "Subagents",
      description: "View work delegated from this task",
      icon: Bot,
      badge: workingSubagents,
      onClose: () => setSelectedSubagent(null),
      render: () => (inspectedSubagent
        ? <SubagentInspector subagent={inspectedSubagent} onClose={() => setSelectedSubagent(null)} />
        : <AgentsPanel subagents={workspace.subagents} onSelect={setSelectedSubagent} />),
    },
    {
      id: "automation",
      title: "Automation",
      description: "Edit the schedule that repeats this task",
      icon: AlarmClock,
      render: () => (
        <AutomationPanel
          automation={workspace.automation}
          onUpdate={(patch) => void workspace.actions.updateAutomation(patch)}
          onDelete={() => void workspace.actions.deleteAutomation()}
          onRunNow={() => void workspace.actions.runAutomationNow()}
        />
      ),
    },
  ];

  const dockLaunchers: DockLauncher[] = [
    ...dockPanels.map(({ id, title, description, icon }) => ({ id, title, description, icon, open: () => openRightTab(id) })),
    { id: "side-chat", title: "Side chat", description: "Start a focused conversation from this task", icon: GitFork, disabled: !workspace.currentTask, open: addSideChat },
  ];

  const dockTabs: DockTab[] = [
    ...dockPanels.filter((panel) => openPanels.includes(panel.id)).map(({ id, title, icon, badge }) => ({ id, title, icon, badge })),
    ...workspace.sideChats.map((chat) => ({ id: chat.id, title: chat.title, icon: GitFork })),
  ];

  return (
    <main className="app-shell">
      <ProjectSidebar
        compactOpen={sidebarOpen}
        inactive={settingsVisible}
        projects={workspace.projects}
        orderedTasks={workspace.orderedTasks}
        recentTasks={workspace.recentTasks}
        currentId={workspace.currentTask?.id ?? null}
        draftProjectId={workspace.currentProject?.id ?? null}
        expandedProjects={workspace.expandedProjects}
        runningTaskIds={workspace.runningTaskIds}
        automatedTaskIds={workspace.automatedTaskIds}
        worktreeTaskIds={workspace.worktreeTaskIds}
        projectsOpen={workspace.projectsOpen}
        recentsOpen={workspace.recentsOpen}
        openMenu={workspace.openMenu}
        settingsOpen={settingsVisible}
        canGoBack={workspace.canGoBack}
        canGoForward={workspace.canGoForward}
        onGoBack={() => void workspace.actions.goBack()}
        onGoForward={() => void workspace.actions.goForward()}
        onNewTask={workspace.actions.newTask}
        onOpenFolder={workspace.actions.openFolder}
        onToggleProject={workspace.actions.toggleProject}
        onRemoveProject={workspace.actions.removeProject}
        onSetProjectsOpen={workspace.actions.setProjectsOpen}
        onSetRecentsOpen={workspace.actions.setRecentsOpen}
        onSetOpenMenu={workspace.actions.setOpenMenu}
        onSelectTask={workspace.actions.selectTask}
        onArchiveTask={workspace.actions.archiveTask}
        onRenameTask={workspace.actions.renameTask}
        onMoveTask={workspace.actions.moveTask}
        onOpenSettings={openSettings}
      />
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

      <section className={`workspace ${sessionPanelVisible ? "summary-open" : ""} ${rightDockOpen ? "dock-open" : ""}`} inert={settingsVisible}>
        <WorkspaceHeader
          currentTask={workspace.currentTask}
          folder={workspace.folder}
          sidebarOpen={sidebarOpen}
          sessionPanelOpen={sessionPanelVisible}
          rightDockOpen={rightDockOpen}
          workingSubagents={workingSubagents}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleSessionPanel={() => {
            setRightDockOpen(false);
            void workspace.actions.setSessionPanelOpen(!sessionPanelVisible);
          }}
          onToggleRightDock={() => {
            if (!rightDockOpen) {
              setActiveRightTab("home");
              setOpenPanels([]);
              setSelectedSubagent(null);
            }
            setRightDockOpen((open) => !open);
          }}
        />
        {(workspace.storageError || workspace.actionError) && (
          <p className="storage-error" role="alert">{workspace.storageError || workspace.actionError}</p>
        )}

        <div className="work-area">
          <div className="conversation" ref={transcriptRef}>
            <ConversationTimeline currentTask={workspace.currentTask} folder={workspace.folder} status={workspace.status} compacting={workspace.compacting} streamingTail={workspace.streamingTail} scrollContainerRef={transcriptRef} onSelectTask={workspace.actions.selectTask} />
            {workspace.approval && <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />}
          </div>
        </div>

        {sessionPanelVisible && (
          <SessionPanel
            environment={workspace.environment}
            hasProject={Boolean(workspace.folder)}
            {...(workspace.currentTask ? { location: workspace.location } : {})}
            runActive={workspace.runActive}
            title={workspace.currentTask?.title ?? ""}
            openMenu={workspace.openMenu}
            onSetOpenMenu={workspace.actions.setOpenMenu}
            onRename={(title) => {
              if (workspace.currentTask) void workspace.actions.renameTask(workspace.currentTask.id, title);
            }}
            subagents={workspace.subagents}
            automationCount={workspace.automation ? 1 : 0}
            onSelect={(id) => {
              setSelectedSubagent(id);
              openRightTab("agents");
            }}
            onOpenAutomations={() => openRightTab("automation")}
            onSetWorktree={(worktree) => {
              const question = worktree
                ? "Give this thread a worktree? It gets its own checkout and works there from now on."
                : "Return this thread to your project checkout? Anything uncommitted in the worktree is committed first.";
              if (window.confirm(question)) void workspace.actions.setWorktree(worktree);
            }}
            onDeleteWorktree={() => {
              if (window.confirm("Delete this worktree? Anything uncommitted in it is lost.")) void workspace.actions.deleteWorktree();
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
            <div className="right-dock-tabs">
              <div role="tablist" aria-label="Right panel tabs">
                {dockTabs.map((tab) => (
                  <div className={`right-dock-tab ${activeRightTab === tab.id ? "active" : ""}`} key={tab.id}>
                    <button type="button" role="tab" aria-selected={activeRightTab === tab.id} onClick={() => setActiveRightTab(tab.id)}>
                      <tab.icon size={15} aria-hidden="true" /><span>{tab.title}</span>
                      {tab.badge ? <em>{tab.badge}</em> : null}
                    </button>
                    <button type="button" aria-label={`Close ${tab.title}`} onClick={() => closeRightTab(tab.id)}><X size={13} /></button>
                  </div>
                ))}
              </div>
              <details className="right-dock-add">
                <summary aria-label="Add right panel tab"><Plus size={18} /></summary>
                <div>
                  {dockLaunchers.map((launcher) => (
                    <button key={launcher.id} type="button" disabled={launcher.disabled} onClick={(event) => { launcher.open(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
                      <launcher.icon size={16} />{launcher.title}
                    </button>
                  ))}
                </div>
              </details>
              <button className="right-dock-hide" type="button" aria-label="Hide right panel" onClick={() => setRightDockOpen(false)}><X size={17} /></button>
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
              {dockPanels.map((panel) => (
                <div key={panel.id} hidden={activeRightTab !== panel.id}>{panel.render()}</div>
              ))}
              {workspace.currentTask && workspace.sideChats.map((chat) => (
                <div key={chat.id} hidden={activeRightTab !== chat.id}>
                  <SideChat
                    chat={chat}
                    source={workspace.currentTask!}
                    project={workspace.currentProject}
                    onPrompt={(prompt) => void workspace.dispatch({ type: "view.set-prompt", taskId: chat.id, prompt })}
                    onSend={(attachments, steer) => void workspace.dispatch({ type: "task.send", taskId: chat.id, attachments, steer })}
                    onCancel={() => void workspace.dispatch({ type: "run.cancel", taskId: chat.id })}
                    onDecide={(allow) => void workspace.dispatch({ type: "run.decide", allow, taskId: chat.id })}
                    onPolicyChange={(policy) => void workspace.dispatch({ type: "task.set-policy", taskId: chat.id, policy })}
                    onModelChange={(model) => void workspace.dispatch({ type: "task.set-model", taskId: chat.id, model })}
                    onEffortChange={(effort) => void workspace.dispatch({ type: "task.set-effort", taskId: chat.id, effort })}
                    onSteerQueued={(messageId) => void workspace.dispatch({ type: "task.steer-queued", taskId: chat.id, messageId })}
                    onDropQueued={(messageId) => void workspace.dispatch({ type: "task.drop-queued", taskId: chat.id, messageId })}
                    onClose={() => closeRightTab(chat.id)}
                    onSelectTask={workspace.actions.selectTask}
                  />
                </div>
              ))}
            </div>
        </aside>

        <TaskComposer
          prompt={workspace.prompt}
          folder={workspace.folder}
          workspaceId={workspace.currentProject?.workspaceId}
          mode={workspace.policy}
          model={workspace.model}
          effort={workspace.effort}
          contextUsage={workspace.currentTask?.contextUsage}
          runActive={workspace.runActive}
          queuedMessages={workspace.queuedMessages}
          onPromptChange={workspace.actions.setPrompt}
          onModeChange={workspace.actions.setPolicy}
          onModelChange={workspace.actions.setModel}
          onEffortChange={workspace.actions.setEffort}
          onSend={(attachments, steer) => {
            if (workspace.prompt.trim() === "/side") {
              workspace.actions.setPrompt("");
              setSelectedSubagent(null);
              addSideChat();
              return;
            }
            void workspace.actions.sendPrompt(attachments, steer);
          }}
          onSteerQueued={workspace.actions.steerQueued}
          onDropQueued={workspace.actions.dropQueued}
          onCancel={workspace.actions.cancelRun}
        />
      </section>
      {settingsVisible && <SettingsPanel onClose={closeSettings} archivedTasks={workspace.archivedTasks} onRestoreTask={workspace.actions.restoreTask} onClearArchive={workspace.actions.clearArchive} />}
    </main>
  );
}
