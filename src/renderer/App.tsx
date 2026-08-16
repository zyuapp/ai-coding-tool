import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { SessionPanel } from "./components/SessionPanel";
import { SubagentInspector } from "./components/SubagentInspector";
import { TaskComposer } from "./components/TaskComposer";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";

export function App() {
  const workspace = useTaskWorkspace();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(true);
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null);
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  const inspectedSubagent = workspace.subagents.find((subagent) => subagent.id === selectedSubagent);

  useEffect(() => {
    if (selectedSubagent && !workspace.subagents.some((subagent) => subagent.id === selectedSubagent)) setSelectedSubagent(null);
  }, [workspace.currentTask?.id, workspace.subagents, selectedSubagent]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [workspace.currentTask?.messages.length, workspace.status, workspace.approval]);

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
        onNewTask={workspace.actions.newTask}
        onOpenFolder={workspace.actions.openFolder}
        onToggleProject={workspace.actions.toggleProject}
        onSetProjectsOpen={workspace.actions.setProjectsOpen}
        onSetRecentsOpen={workspace.actions.setRecentsOpen}
        onSetOpenMenu={workspace.actions.setOpenMenu}
        onSelectTask={workspace.actions.selectTask}
        onArchiveTask={workspace.actions.archiveTask}
      />

      <section className={`workspace ${sessionPanelOpen ? "summary-open" : ""} ${inspectedSubagent ? "inspector-open" : ""}`}>
        <WorkspaceHeader
          currentTask={workspace.currentTask}
          folder={workspace.folder}
          sessionPanelOpen={sessionPanelOpen}
          inspectorOpen={Boolean(inspectedSubagent)}
          workingSubagents={workingSubagents}
          onToggleSessionPanel={() => {
            setSelectedSubagent(null);
            setSessionPanelOpen((open) => !open);
          }}
          onToggleInspector={() => setSelectedSubagent(null)}
        />
        {(workspace.storageError || workspace.actionError) && (
          <p className="storage-error" role="alert">{workspace.storageError || workspace.actionError}</p>
        )}

        <div className="work-area">
          <div className="conversation" ref={transcriptRef}>
            <ConversationTimeline currentTask={workspace.currentTask} folder={workspace.folder} status={workspace.status} compacting={workspace.compacting} />
            {workspace.approval && <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />}
          </div>
        </div>

        {sessionPanelOpen && (
          <SessionPanel
            environment={workspace.environment}
            hasProject={Boolean(workspace.folder)}
            subagents={workspace.subagents}
            onSelect={(id) => {
              setSessionPanelOpen(false);
              setSelectedSubagent(id);
            }}
          />
        )}

        {inspectedSubagent && <SubagentInspector subagent={inspectedSubagent} onClose={() => {
          setSelectedSubagent(null);
          setSessionPanelOpen(true);
        }} />}

        <TaskComposer
          prompt={workspace.prompt}
          folder={workspace.folder}
          mode={workspace.policy}
          model={workspace.model}
          contextWindow={workspace.contextWindow}
          contextUsage={workspace.currentTask?.contextUsage}
          runActive={workspace.runActive}
          onPromptChange={workspace.actions.setPrompt}
          onModeChange={workspace.actions.setPolicy}
          onModelChange={workspace.actions.setModel}
          onContextWindowChange={workspace.actions.setContextWindow}
          onSend={() => void workspace.actions.sendPrompt()}
          onCancel={workspace.actions.cancelRun}
        />
      </section>
    </main>
  );
}
