import { useEffect, useRef, useState } from "react";
import { Bot, GitFork, Plus, X } from "lucide-react";
import { ApprovalCard } from "./components/ApprovalCard";
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
  const sideChatSequence = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sideChats, setSideChats] = useState<{ id: string; title: string }[]>([]);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(() => window.innerWidth >= 1400);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState("agents");
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsVisible = settingsOpen || workspace.computerUseSetup;
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  const inspectedSubagent = workspace.subagents.find((subagent) => subagent.id === selectedSubagent);

  function addSideChat() {
    sideChatSequence.current += 1;
    const chat = { id: crypto.randomUUID(), title: `Chat ${sideChatSequence.current}` };
    setSideChats((current) => [...current, chat]);
    setActiveRightTab(chat.id);
    setSessionPanelOpen(false);
    setRightDockOpen(true);
  }

  function openRightTab(id: string) {
    setActiveRightTab(id);
    setSessionPanelOpen(false);
    setRightDockOpen(true);
  }

  function closeSideChat(id: string) {
    const index = sideChats.findIndex((chat) => chat.id === id);
    setSideChats((current) => current.filter((chat) => chat.id !== id));
    if (activeRightTab === id) setActiveRightTab(sideChats[index - 1]?.id ?? sideChats[index + 1]?.id ?? "agents");
  }

  function openSettings() {
    setSettingsOpen(true);
    setSidebarOpen(false);
    setSessionPanelOpen(false);
    setRightDockOpen(false);
  }

  function closeSettings() {
    setSettingsOpen(false);
    workspace.actions.dismissComputerUseSetup();
  }

  useEffect(() => {
    if (selectedSubagent && !workspace.subagents.some((subagent) => subagent.id === selectedSubagent)) setSelectedSubagent(null);
  }, [workspace.currentTask?.id, workspace.subagents, selectedSubagent]);

  useEffect(() => {
    setSideChats([]);
    sideChatSequence.current = 0;
    setActiveRightTab("agents");
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
        status={workspace.globalStatus}
        runningTaskId={workspace.runningTaskId}
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
        onOpenSettings={openSettings}
      />
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

      <section className={`workspace ${sessionPanelOpen ? "summary-open" : ""} ${rightDockOpen ? "dock-open" : ""}`} inert={settingsVisible}>
        <WorkspaceHeader
          currentTask={workspace.currentTask}
          folder={workspace.folder}
          sidebarOpen={sidebarOpen}
          sessionPanelOpen={sessionPanelOpen}
          rightDockOpen={rightDockOpen}
          workingSubagents={workingSubagents}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleSessionPanel={() => {
            setRightDockOpen(false);
            setSessionPanelOpen((open) => !open);
          }}
          onToggleRightDock={() => {
            setSessionPanelOpen(false);
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

        {sessionPanelOpen && (
          <SessionPanel
            environment={workspace.environment}
            hasProject={Boolean(workspace.folder)}
            subagents={workspace.subagents}
            onSelect={(id) => {
              setSelectedSubagent(id);
              openRightTab("agents");
            }}
          />
        )}

        <aside className="right-dock" aria-label="Right panel" hidden={!rightDockOpen}>
            <div className="right-dock-tabs">
              <div role="tablist" aria-label="Right panel tabs">
                <button className={activeRightTab === "agents" ? "active" : ""} type="button" role="tab" aria-selected={activeRightTab === "agents"} onClick={() => openRightTab("agents")}>
                  <Bot size={15} aria-hidden="true" /><span>Agents</span>
                  {workingSubagents > 0 && <em>{workingSubagents}</em>}
                </button>
                {sideChats.map((chat) => (
                  <div className={`right-dock-chat-tab ${activeRightTab === chat.id ? "active" : ""}`} key={chat.id}>
                    <button type="button" role="tab" aria-selected={activeRightTab === chat.id} onClick={() => setActiveRightTab(chat.id)}><GitFork size={14} aria-hidden="true" /><span>{chat.title}</span></button>
                    <button type="button" aria-label={`Close ${chat.title}`} onClick={() => closeSideChat(chat.id)}><X size={13} /></button>
                  </div>
                ))}
              </div>
              <details className="right-dock-add">
                <summary aria-label="Add right panel tab"><Plus size={18} /></summary>
                <div>
                  <button type="button" onClick={(event) => { openRightTab("agents"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><Bot size={16} />Agents</button>
                  <button type="button" disabled={!workspace.currentTask} onClick={(event) => { addSideChat(); event.currentTarget.closest("details")?.removeAttribute("open"); }}><GitFork size={16} />Side chat</button>
                </div>
              </details>
              <button className="right-dock-hide" type="button" aria-label="Hide right panel" onClick={() => setRightDockOpen(false)}><X size={17} /></button>
            </div>
            <div className="right-dock-content">
              <div hidden={activeRightTab !== "agents"}>
                {inspectedSubagent ? <SubagentInspector subagent={inspectedSubagent} onClose={() => setSelectedSubagent(null)} /> : (
                  <AgentsPanel subagents={workspace.subagents} onSelect={setSelectedSubagent} />
                )}
              </div>
              {workspace.currentTask && sideChats.map((chat) => (
                <div key={chat.id} hidden={activeRightTab !== chat.id}>
                  <SideChat source={workspace.currentTask!} project={workspace.currentProject} title={chat.title} onClose={() => closeSideChat(chat.id)} />
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
          contextWindow={workspace.contextWindow}
          contextUsage={workspace.currentTask?.contextUsage}
          runActive={workspace.runActive}
          onPromptChange={workspace.actions.setPrompt}
          onModeChange={workspace.actions.setPolicy}
          onModelChange={workspace.actions.setModel}
          onContextWindowChange={workspace.actions.setContextWindow}
          onSend={() => {
            if (workspace.prompt.trim() === "/side") {
              workspace.actions.setPrompt("");
              setSelectedSubagent(null);
              addSideChat();
              return;
            }
            void workspace.actions.sendPrompt();
          }}
          onCancel={workspace.actions.cancelRun}
        />
      </section>
      {settingsVisible && <SettingsPanel onClose={closeSettings} />}
    </main>
  );
}
