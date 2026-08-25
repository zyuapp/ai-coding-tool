import { useCallback } from "react";
import { X } from "lucide-react";
import { MessageLinkProvider } from "./components/MarkdownMessage";
import { DiagramViewerHost } from "./components/MermaidBlock";
import { FindBar } from "./components/FindBar";
import { ProjectEditDialog } from "./components/ProjectEditDialog";
import { RightDock } from "./components/RightDock";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceComposer } from "./components/WorkspaceComposer";
import { WorkspaceConversation } from "./components/WorkspaceConversation";
import { WorkspaceSession } from "./components/WorkspaceSession";
import { WorkspaceSettings } from "./components/WorkspaceSettings";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { buildDock, unreviewedFileCount } from "./components/dock-registry";
import { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";
import { useFileDrop, useRefusedStrayDrops } from "./file-drop";
import { attachDroppedFiles, imageSources } from "./dropped-files";
import { useComposerFocusRecovery, useEscapeLayers, useLatestDispatch, useMessageLinks, useSubagentInspection } from "./app-shell";

export function App() {
  const workspace = useTaskWorkspace();
  const inspector = useSubagentInspection(workspace);
  const sidebarOpen = workspace.sidebarOpen;
  const settingsVisible = workspace.settingsOpen;
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  /** The tab counts what is still to read, so ticking files off empties it the way working down a list should. */
  const unreviewedFiles = unreviewedFileCount(workspace.diff);
  const rightDockOpen = workspace.dockOpen;
  const rightDockExpanded = rightDockOpen && workspace.dockExpanded;
  const activeRightTab = workspace.dockTab;
  /** The right dock takes the same space, so it hides the panel without discarding the choice. */
  const sessionPanelVisible = workspace.sessionPanelOpen && !rightDockOpen;
  const find = workspace.find;
  const findBar = find ? (
    <FindBar
      find={find}
      label={find.target.kind === "browser" ? "page" : find.target.kind === "terminal" ? "terminal" : "thread"}
      onQuery={workspace.actions.setFindQuery}
      onStep={workspace.actions.stepFind}
      onClose={workspace.actions.closeFind}
    />
  ) : null;

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

  function openSettings() {
    void workspace.actions.setSettingsOpen(true);
  }

  function closeSettings() {
    void workspace.actions.setSettingsOpen(false);
  }

  useEscapeLayers(workspace);

  const openWorkflow = useCallback((id: string) => {
    void workspace.actions.openWorkflow(id);
  }, [workspace.actions]);

  const { panels: dockPanels, launchers: dockLaunchers } = buildDock({
    workspace,
    inspectedSubagent: inspector.inspected,
    workingSubagents,
    unreviewedFiles,
    onInspectSubagent: inspector.inspect,
    onCloseInspector: inspector.close,
    onOpenPanel: openRightTab,
    onAddSideChat: addSideChat,
  });

  /** The `/` menu is the dock registry, so a view added there is reachable from the composer too. */
  const composerActions = dockLaunchers
    .filter((launcher) => !launcher.disabled)
    .map(({ command, description, open }) => ({ name: command, description, run: open }));

  const dockFocus = workspace.dockFocus;

  /** A page the app handed the keyboard to is holding it on purpose, and must not have it taken back. */
  const pageTookKeys = dockFocus !== null && dockFocus.tab === activeRightTab && workspace.browserTabs.some((tab) => tab.id === dockFocus.tab && tab.url);

  const dispatchRef = useLatestDispatch(workspace.dispatch);

  useComposerFocusRecovery(dispatchRef, { dockOpen: rightDockOpen, sidebarOpen, settingsVisible, pageTookKeys, dockFocus, dockTab: activeRightTab });

  /** A file dropped anywhere in the window that is not a surface of its own belongs to this thread. */
  const workspaceDrop = useFileDrop((files) => void attachDroppedFiles(files, undefined, workspace.dispatch, imageSources(workspace.images)));

  useRefusedStrayDrops();

  const messageLinks = useMessageLinks(dispatchRef);

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
            if (!rightDockOpen) inspector.clear();
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

        <WorkspaceConversation workspace={workspace} find={find} findBar={findBar} onAnnotateSide={annotateToSideChat} />

        {sessionPanelVisible && (
          <WorkspaceSession
            workspace={workspace}
            onInspectSubagent={inspector.inspect}
            onOpenPanel={openRightTab}
            onOpenWorkflow={openWorkflow}
          />
        )}

        <RightDock
          workspace={workspace}
          panels={dockPanels}
          launchers={dockLaunchers}
          open={rightDockOpen}
          expanded={rightDockExpanded}
          sidebarOpen={sidebarOpen}
          settingsVisible={settingsVisible}
          find={find}
          findBar={findBar}
        />

        <WorkspaceComposer workspace={workspace} actions={composerActions} />
        {workspaceDrop.over && <p className="drop-hint" role="status">Drop to attach</p>}
      </section>
      {workspace.projectEditor && (
        <ProjectEditDialog
          editor={workspace.projectEditor}
          onSave={(edit) => void workspace.actions.editProject(workspace.projectEditor!.project.id, edit)}
          onClose={() => void workspace.actions.editProjectClose()}
        />
      )}
      {settingsVisible && <WorkspaceSettings workspace={workspace} onClose={closeSettings} />}
    </main>
    </DiagramViewerHost>
    </MessageLinkProvider>
  );
}
