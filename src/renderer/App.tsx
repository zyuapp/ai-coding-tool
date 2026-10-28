import { lazy, Suspense, useCallback } from "react";
import { CommandControlsProvider } from "./components/CommandControl";
import { LuFocus as Focus, LuX as X } from "react-icons/lu";
import { MessageLinkProvider } from "./components/MarkdownMessage";
import { AttachmentViewer } from "./components/AttachmentViewer";
import { DiagramViewerHost } from "./components/MermaidBlock";
import { FindBar } from "./components/FindBar";
import { shortcutTip, TooltipLayer } from "./components/TooltipLayer";
import { Toasts } from "./components/Toasts";
import { WorkspaceDialogs } from "./components/WorkspaceDialogs";
import { RightDock } from "./components/RightDock";
import { Sidebar } from "./components/Sidebar";
import { ThreadJump } from "./components/ThreadJump";
import { WorkspaceComposer } from "./components/WorkspaceComposer";
import { WorkspaceConversation } from "./components/WorkspaceConversation";
import { WorkspaceSession } from "./components/WorkspaceSession";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { buildDock, findLabel, unreviewedFileCount } from "./components/dock-registry";
import { useTaskWorkspace } from "./task-workspace/useTaskWorkspace";
import { useFileDrop, useRefusedStrayDrops } from "./file-drop";
import { attachDroppedFiles, imageSources } from "./dropped-files";
import { useComposerFocusRecovery, useEscapeLayers, useLatestDispatch, useMessageLinks, useSubagentInspection } from "./app-shell";
import { PartBoundary } from "./components/PartBoundary";
import type { Thread } from "../domain/thread";

/** A thread on a computer holding no coordinators can be moved under none. */
const NO_COORDINATORS: readonly Thread[] = [];

const loadSettings = () => import("./components/WorkspaceSettings");
const WorkspaceSettings = lazy(() => loadSettings().then((module) => ({ default: module.WorkspaceSettings })));

/** Settings is its own chunk, fetched while the app is idle so the sheet opens without waiting on it. */
if (typeof window !== "undefined" && "requestIdleCallback" in window) {
  window.requestIdleCallback(() => void loadSettings().catch(() => undefined));
}

/** Threads a newer build wrote, which this one left on disk. The count returns on the next launch. */
function HiddenThreadsNotice({ workspace }: { workspace: ReturnType<typeof useTaskWorkspace> }) {
  const hidden = workspace.hiddenThreads;
  if (hidden < 1) return null;
  return (
    <div className="storage-notice" role="status">
      <span>{hidden} {hidden === 1 ? "thread needs" : "threads need"} a newer version</span>
      <button className="storage-notice-link" type="button" onClick={() => void workspace.actions.checkForUpdates()}>Update</button>
      <button type="button" aria-label="Dismiss" data-tip="Dismiss" onClick={() => void workspace.actions.dismissHiddenThreads()}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** What zen mode leaves of the topbar: a strip to drag the window by, and the way back out. */
function ZenTitlebar({ tip, onLeave }: { tip: string; onLeave: () => void }) {
  return (
    <div className="zen-titlebar">
      <button className="session-toggle active" type="button" aria-label="Leave zen mode" data-tip={tip} onClick={onLeave}>
        <Focus size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The keystroke zen mode is bound to, for the tooltips that offer it. */
function zenTip(workspace: ReturnType<typeof useTaskWorkspace>, label: string) {
  const binding = workspace.shortcuts.find((row) => row.id === "zen.toggle")?.binding;
  return binding ? shortcutTip(label, binding) : label;
}

/** The error the last action ran into, with the settings page that clears it when there is one. */
function ActionErrorBanner({ workspace }: { workspace: ReturnType<typeof useTaskWorkspace> }) {
  const message = workspace.storageError || workspace.actionError;
  if (!message) return null;
  /** The settings page that clears the error, when one does. */
  const errorPage = workspace.actionErrorPage;
  return (
    <div className="storage-error" role="alert">
      <span>{message}</span>
      {!workspace.storageError && errorPage && (
        <button className="storage-error-link" type="button" onClick={() => void workspace.actions.openSettingsSection(errorPage)}>Open settings</button>
      )}
      {!workspace.storageError && (
        <button type="button" aria-label="Dismiss error" data-tip="Dismiss" onClick={() => void workspace.dispatch({ type: "view.dismiss-action-error" })}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function App() {
  const workspace = useTaskWorkspace();
  const dispatchRef = useLatestDispatch(workspace.dispatch);
  useEscapeLayers(dispatchRef);
  const inspector = useSubagentInspection(workspace);
  const sidebarOpen = workspace.sidebarOpen && !workspace.zen;
  const settingsVisible = workspace.settingsOpen;
  const workingSubagents = workspace.subagents.filter((subagent) => subagent.status === "working").length;
  /** The tab counts what is still to read, so ticking files off empties it the way working down a list should. */
  const unreviewedFiles = unreviewedFileCount(workspace.diff);
  const rightDockOpen = workspace.dockOpen && !workspace.zen;
  const rightDockExpanded = rightDockOpen && workspace.dockExpanded;
  const activeRightTab = workspace.dockTab;
  /** The right dock takes the same space, so it hides the panel without discarding the choice. */
  const sessionPanelVisible = workspace.sessionPanelOpen && !rightDockOpen && !workspace.zen;
  const find = workspace.find;

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

  const openSettings = useCallback(() => void workspace.actions.setSettingsOpen(true), [workspace.actions]);
  const closeSettings = () => void workspace.actions.setSettingsOpen(false);

  const openWorkflow = useCallback((id: string) => void workspace.actions.openWorkflow(id), [workspace.actions]);

  const { panels: dockPanels, launchers: dockLaunchers } = buildDock({
    workspace,
    inspectedSubagent: inspector.inspected,
    workingSubagents,
    unreviewedFiles,
    onInspectSubagent: inspector.inspect,
    onCloseInspector: inspector.close,
    onOpenPanel: workspace.actions.openDockPanel,
    onAddSideChat: addSideChat,
  });

  /** Built after the registry, which is the only thing that knows what a panel is called. */
  const findBar = find ? (
    <FindBar
      find={find}
      label={findLabel(find.target, dockPanels)}
      onQuery={workspace.actions.setFindQuery}
      onStep={workspace.actions.stepFind}
      onClose={workspace.actions.closeFind}
    />
  ) : null;

  /** The `/` menu is the dock registry, so a view added there is reachable from the composer too. */
  const composerActions = dockLaunchers
    .filter((launcher) => !launcher.disabled)
    .map(({ command, description, open }) => ({ name: command, description, run: open }));

  const dockFocus = workspace.dockFocus;

  /** A page the app handed the keyboard to is holding it on purpose, and must not have it taken back. */
  const pageTookKeys = dockFocus !== null && dockFocus.tab === activeRightTab && workspace.browserTabs.some((tab) => tab.id === dockFocus.tab && tab.url);

  useComposerFocusRecovery(dispatchRef, { dockOpen: rightDockOpen, sidebarOpen, settingsVisible, pageTookKeys, dockFocus, dockTab: activeRightTab });

  /** A file dropped anywhere in the window that is not a surface of its own belongs to this thread. */
  const workspaceDrop = useFileDrop((files) => void attachDroppedFiles(files, undefined, workspace.dispatch, imageSources(workspace.images)));

  useRefusedStrayDrops();

  const messageLinks = useMessageLinks(dispatchRef);

  /** The window opens before the store has loaded, and an empty workspace would read as no threads. */
  if (!workspace.restored) return <main className="app-shell" />;
  /** What the workspace shows, so a part that failed on one thread draws again for the next. */
  const shownKey = workspace.currentThread?.id ?? `draft:${workspace.currentProject?.id ?? ""}`;

  return (
    <CommandControlsProvider value={workspace.commandControls}><MessageLinkProvider actions={messageLinks}>
    {workspace.viewingImage && <AttachmentViewer key={workspace.viewingImage} source={workspace.viewingImage} onClose={() => void workspace.dispatch({ type: "image.close" })} onDownload={() => void workspace.dispatch({ type: "image.download" })} />}
    <DiagramViewerHost>
    <main className={`app-shell ${workspace.zen ? "zen" : ""}`.trimEnd()}>
      <PartBoundary name="sidebar" className={`sidebar ${sidebarOpen ? "compact-open" : "hidden"}`}>
        <Sidebar workspace={workspace} open={sidebarOpen} settingsVisible={settingsVisible} onOpenSettings={openSettings} />
      </PartBoundary>
      {sidebarOpen && <button className="sidebar-backdrop" type="button" tabIndex={-1} aria-label="Close sidebar" onClick={() => void workspace.actions.setSidebarOpen(false)} />}

      <section
        className={`workspace ${sessionPanelVisible ? "summary-open" : ""} ${rightDockOpen ? "dock-open" : ""} ${rightDockExpanded ? "dock-full" : ""} ${workspaceDrop.over ? "dropping" : ""}`}
        inert={settingsVisible}
        {...workspaceDrop.props}
      >
        {workspace.zen ? <ZenTitlebar tip={zenTip(workspace, "Leave zen mode")} onLeave={() => void workspace.dispatch({ type: "view.set-zen", zen: false })} /> : <PartBoundary name="header" className={`topbar ${sidebarOpen ? "" : "traffic-inset"}`.trimEnd()} resetKey={shownKey}>
          <WorkspaceHeader
            currentThread={workspace.currentThread}
            folder={workspace.folder}
            folderLabel={workspace.folderLabel}
            host={workspace.activeComputer && { name: workspace.activeComputer.name, offline: workspace.activeComputer.status !== "connected", reconnecting: workspace.activeComputer.status === "connecting" }}
            sidebarOpen={sidebarOpen}
            sessionPanelOpen={sessionPanelVisible}
            rightDockOpen={rightDockOpen}
            workingSubagents={workingSubagents} zen={{ available: workspace.zenAvailable, tip: zenTip(workspace, "Zen mode"), onEnter: () => void workspace.dispatch({ type: "view.set-zen", zen: true }) }}
            openMenu={workspace.openMenu}
            canOpenFolder={Boolean(workspace.folder) && workspace.location?.kind !== "creating"}
            onSetOpenMenu={workspace.actions.setOpenMenu} apps={workspace.installedApps} onListApps={() => void workspace.actions.listApps()}
            onOpenInApp={(appId) => void workspace.actions.openFolderInApp(appId)}
            onRenameThread={workspace.actions.renameThread}
            onForkThread={workspace.actions.forkThread}
            onArchiveThread={workspace.actions.archiveThread} onSetThreadRole={workspace.actions.setThreadRole}
            coordinators={workspace.coordinatorsByComputer.get(workspace.activeComputer?.id ?? null) ?? NO_COORDINATORS} onSetCoordinator={workspace.actions.setCoordinator}
            notifications={workspace.notifications} onSetMuted={workspace.actions.setMuted}
            stoppable={Boolean(workspace.currentThread && workspace.stoppableCoordinatorIds.has(workspace.currentThread.id))}
            onStopAll={workspace.actions.stopAll} onChooseFolder={() => void workspace.actions.openFolder()}
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
        </PartBoundary>}
        {/** Every banner takes a row of its own, so none is drawn over another. */}
        <div className="workspace-banners">
          <ActionErrorBanner workspace={workspace} />
          {!workspace.storageError && !workspace.zen && <HiddenThreadsNotice workspace={workspace} />}
        </div>

        <PartBoundary name="conversation" className="work-area" resetKey={shownKey}>
          <WorkspaceConversation workspace={workspace} find={find} findBar={findBar} onAnnotateSide={annotateToSideChat} />
        </PartBoundary>

        {sessionPanelVisible && (
          <WorkspaceSession
            workspace={workspace}
            onInspectSubagent={inspector.inspect}
            onOpenPanel={workspace.actions.openDockPanel}
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

        <PartBoundary name="composer" className="composer-wrap main" resetKey={shownKey}>
          <WorkspaceComposer workspace={workspace} actions={composerActions} />
        </PartBoundary>
        {workspaceDrop.over && <p className="drop-hint" role="status">Drop to attach</p>}
      </section>
      <WorkspaceDialogs workspace={workspace} />
      {settingsVisible && <Suspense fallback={null}><WorkspaceSettings workspace={workspace} onClose={closeSettings} /></Suspense>}
      {workspace.jump && <ThreadJump jump={workspace.jump} actions={workspace.actions} />}
      <Toasts toasts={workspace.zen ? workspace.toasts.filter((toast) => toast.tone === "error") : workspace.toasts} onDismiss={(id) => void workspace.actions.dismissToast(id)} onAction={(command) => void workspace.dispatch(command)} />
      <TooltipLayer />
    </main>
    </DiagramViewerHost>
    </MessageLinkProvider></CommandControlsProvider>
  );
}
