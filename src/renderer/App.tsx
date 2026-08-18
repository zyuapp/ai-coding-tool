import { useEffect, useRef, useState } from "react";
import { AlarmClock, Bot, GitFork, Plus, X } from "lucide-react";
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

export function App() {
  const workspace = useTaskWorkspace();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState("home");
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
    setActiveRightTab(id);
    setRightDockOpen(true);
  }

  function closeSideChat(id: string) {
    const chats = workspace.sideChats;
    const index = chats.findIndex((chat) => chat.id === id);
    void workspace.dispatch({ type: "side-chat.close", chatId: id });
    if (activeRightTab === id) setActiveRightTab(chats[index - 1]?.id ?? chats[index + 1]?.id ?? "home");
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
    setSelectedSubagent(null);
  }, [workspace.currentTask?.id]);

  useEffect(() => {
    function dismissMenu(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest("[data-popover-menu]")) workspace.actions.setOpenMenu(null);
    }
    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") workspace.actions.setOpenMenu(null);
    }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [workspace.actions]);

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
        projectsOpen={workspace.projectsOpen}
        recentsOpen={workspace.recentsOpen}
        openMenu={workspace.openMenu}
        settingsOpen={settingsVisible}
        onNewTask={workspace.actions.newTask}
        onOpenFolder={workspace.actions.openFolder}
        onToggleProject={workspace.actions.toggleProject}
        onRemoveProject={workspace.actions.removeProject}
        onSetProjectsOpen={workspace.actions.setProjectsOpen}
        onSetRecentsOpen={workspace.actions.setRecentsOpen}
        onSetOpenMenu={workspace.actions.setOpenMenu}
        onSelectTask={workspace.actions.selectTask}
        onArchiveTask={workspace.actions.archiveTask}
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
            <ConversationTimeline currentTask={workspace.currentTask} folder={workspace.folder} status={workspace.status} compacting={workspace.compacting} scrollContainerRef={transcriptRef} />
            {workspace.approval && <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />}
          </div>
        </div>

        {sessionPanelVisible && (
          <SessionPanel
            environment={workspace.environment}
            hasProject={Boolean(workspace.folder)}
            subagents={workspace.subagents}
            automationCount={workspace.automation ? 1 : 0}
            onSelect={(id) => {
              setSelectedSubagent(id);
              openRightTab("agents");
            }}
            onOpenAutomations={() => openRightTab("automation")}
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
                {activeRightTab !== "home" && (
                  <button className={activeRightTab === "agents" ? "active" : ""} type="button" role="tab" aria-selected={activeRightTab === "agents"} onClick={() => openRightTab("agents")}>
                    <Bot size={15} aria-hidden="true" /><span>Subagents</span>
                    {workingSubagents > 0 && <em>{workingSubagents}</em>}
                  </button>
                )}
                {activeRightTab === "automation" && (
                  <button className="active" type="button" role="tab" aria-selected={true} onClick={() => openRightTab("automation")}>
                    <AlarmClock size={15} aria-hidden="true" /><span>Automation</span>
                  </button>
                )}
                {workspace.sideChats.map((chat) => (
                  <div className={`right-dock-chat-tab ${activeRightTab === chat.id ? "active" : ""}`} key={chat.id}>
                    <button type="button" role="tab" aria-selected={activeRightTab === chat.id} onClick={() => setActiveRightTab(chat.id)}><GitFork size={14} aria-hidden="true" /><span>{chat.title}</span></button>
                    <button type="button" aria-label={`Close ${chat.title}`} onClick={() => closeSideChat(chat.id)}><X size={13} /></button>
                  </div>
                ))}
              </div>
              <details className="right-dock-add">
                <summary aria-label="Add right panel tab"><Plus size={18} /></summary>
                <div>
                  <button type="button" onClick={(event) => { openRightTab("agents"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><Bot size={16} />Subagents</button>
                  <button type="button" onClick={(event) => { openRightTab("automation"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><AlarmClock size={16} />Automation</button>
                  <button type="button" disabled={!workspace.currentTask} onClick={(event) => { addSideChat(); event.currentTarget.closest("details")?.removeAttribute("open"); }}><GitFork size={16} />Side chat</button>
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
                  <button type="button" aria-label="Open Subagents panel" onClick={() => openRightTab("agents")}>
                    <Bot size={19} aria-hidden="true" />
                    <span><strong>Subagents</strong><small>View work delegated from this task</small></span>
                  </button>
                  <button type="button" aria-label="Open Automation panel" onClick={() => openRightTab("automation")}>
                    <AlarmClock size={19} aria-hidden="true" />
                    <span><strong>Automation</strong><small>Edit the schedule that repeats this task</small></span>
                  </button>
                  <button type="button" aria-label="Open Side chat panel" disabled={!workspace.currentTask} onClick={addSideChat}>
                    <GitFork size={19} aria-hidden="true" />
                    <span><strong>Side chat</strong><small>Start a focused conversation from this task</small></span>
                  </button>
                </div>
              </div>
              <div hidden={activeRightTab !== "agents"}>
                {inspectedSubagent ? <SubagentInspector subagent={inspectedSubagent} onClose={() => setSelectedSubagent(null)} /> : (
                  <AgentsPanel subagents={workspace.subagents} onSelect={setSelectedSubagent} />
                )}
              </div>
              <div hidden={activeRightTab !== "automation"}>
                <AutomationPanel
                  automation={workspace.automation}
                  onUpdate={(patch) => void workspace.actions.updateAutomation(patch)}
                  onDelete={() => void workspace.actions.deleteAutomation()}
                  onRunNow={() => void workspace.actions.runAutomationNow()}
                />
              </div>
              {workspace.currentTask && workspace.sideChats.map((chat) => (
                <div key={chat.id} hidden={activeRightTab !== chat.id}>
                  <SideChat
                    chat={chat}
                    source={workspace.currentTask!}
                    project={workspace.currentProject}
                    onPrompt={(prompt) => void workspace.dispatch({ type: "side-chat.set-prompt", chatId: chat.id, prompt })}
                    onSend={() => void workspace.dispatch({ type: "side-chat.send", chatId: chat.id })}
                    onCancel={() => void workspace.dispatch({ type: "side-chat.cancel", chatId: chat.id })}
                    onClose={() => closeSideChat(chat.id)}
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
      {settingsVisible && <SettingsPanel onClose={closeSettings} />}
    </main>
  );
}
