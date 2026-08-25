import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { DockSideChats } from "./DockSideChat";
import { TerminalPanel } from "./TerminalPanel";
import type { DockLauncher, DockPanel } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { usePanelFind } from "../find/use-panel-find";
import { DIFF_PANEL, type FindView } from "../../application/workspace-state";
import type { FindResults } from "../../domain/find";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/**
 * One panel's tab: the view, and the find bar above it when it is the one being searched. The bar
 * sits in the same place in every tab, so a panel never draws one of its own.
 */
export function DockPanelTab({ panel, active, focusToken, find, findBar, onResults }: {
  panel: DockPanel;
  active: boolean;
  /** Bumped whenever something asks this panel to take the keyboard. */
  focusToken: number;
  find: FindView | null;
  findBar: ReactNode;
  onResults: (results: FindResults) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** The review counts its rows rather than its drawing, since most of them are never drawn. */
  const drawnFind = find?.target.kind === "panel" && find.target.panel === panel.id ? find : null;
  usePanelFind({ root: body, find: drawnFind, onResults });
  const mine = drawnFind !== null || (find?.target.kind === "review" && panel.id === DIFF_PANEL);

  /**
   * A panel holds the keyboard the way a page, a shell and a side chat already do. Without this the
   * caret stays in the composer while the user reads the panel, and ⌘F would answer with the thread.
   */
  useEffect(() => {
    if (focusToken) body.current?.focus({ preventScroll: true });
  }, [focusToken]);

  /**
   * How tall the panel's own header is, so the bar hangs under it rather than over what it holds.
   * Every panel draws its header first, and a panel that draws none gets the top of the panel.
   */
  useLayoutEffect(() => {
    if (!mine) return;
    const head = body.current?.firstElementChild?.querySelector(":scope > header");
    panelRef.current?.style.setProperty("--find-head", `${head?.getBoundingClientRect().height ?? 0}px`);
  });

  return (
    <div className="dock-panel" ref={panelRef} data-dock-tab={panel.id} hidden={!active}>
      {mine && findBar}
      {/**
        * The body is its own element so the query typed into the bar is never painted as a match, and
        * it takes the keys itself: a panel is read rather than typed into, so nothing inside it would
        * otherwise ever hold them.
        */}
      <div className="dock-panel-body" ref={body} tabIndex={-1}>{panel.render()}</div>
    </div>
  );
}

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
        <DockPanelTab
          key={panel.id}
          panel={panel}
          active={activeTab === panel.id}
          focusToken={focusTokenFor(panel.id)}
          find={find}
          findBar={findBar}
          onResults={(results) => { if (find) void workspace.actions.reportFind(find.target, results); }}
        />
      ))}
      {/** A page is a native view main draws over the panel, so only the one on top is ever drawn. */}
      {browserTab && (
        <div data-dock-tab={browserTab.id}>
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
        <div data-dock-tab={shownTerminal.id}>
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
          find={find}
          findBar={findBar}
          focusTokenFor={focusTokenFor}
          onClose={onCloseTab}
        />
      )}
    </div>
  );
}
