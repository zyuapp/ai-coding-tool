import type { ReactNode } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { DockSideChats } from "./DockSideChat";
import { TerminalPanel } from "./TerminalPanel";
import type { DockLauncher, DockPanel } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { FindView } from "../../application/workspace-state";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** Everything the dock can show, with only the tab that is selected left unhidden. */
export function DockContent({ workspace, panels, launchers, activeTab, find, findBar, dockOpen, settingsVisible, focusTokenFor, onCloseTab }: {
  workspace: Workspace;
  panels: DockPanel[];
  launchers: DockLauncher[];
  activeTab: string;
  find: FindView | null;
  findBar: ReactNode;
  dockOpen: boolean;
  settingsVisible: boolean;
  focusTokenFor: (tab: string) => number;
  onCloseTab: (id: string) => void;
}) {
  const browserTab = workspace.browserTabs.find((tab) => tab.id === activeTab);
  const shownTerminal = workspace.terminals.find((terminal) => terminal.id === activeTab);
  return (
    <div className="right-dock-content">
      <div className="right-dock-picker" hidden={activeTab !== "home"} aria-label="Choose a right panel">
        <header>
          <h2>Choose a panel</h2>
          <p>Inspect delegated work or start a focused conversation.</p>
        </header>
        <div>
          {launchers.map((launcher) => (
            <button key={launcher.id} type="button" aria-label={`Open ${launcher.title} panel`} disabled={launcher.disabled} onClick={launcher.open}>
              <launcher.icon size={19} aria-hidden="true" />
              <span><strong>{launcher.title}</strong><small>{launcher.description}</small></span>
            </button>
          ))}
        </div>
      </div>
      {panels.filter((panel) => workspace.dockPanels.includes(panel.id)).map((panel) => (
        <div key={panel.id} hidden={activeTab !== panel.id}>{panel.render()}</div>
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
            visible={dockOpen && !settingsVisible}
            onInput={(terminalId, data) => void workspace.actions.sendToTerminal(terminalId, data)}
            onResize={(terminalId, cols, rows) => void workspace.actions.resizeTerminal(terminalId, cols, rows)}
          />
        </div>
      )}
      {workspace.currentTask && (
        <DockSideChats
          workspace={workspace}
          source={workspace.currentTask}
          activeTab={activeTab}
          focusTokenFor={focusTokenFor}
          onClose={onCloseTab}
        />
      )}
    </div>
  );
}
