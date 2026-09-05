import type { WorkspaceEffect } from "../../application/workspace-reducer";
import { clearTerminalSearch, disposeTerminalView, searchTerminalView } from "./terminal-views";
import { reportFailure, type EffectHost } from "./effect-host";

/** The panels that hold something of their own: pages, shells, and the files opened out of them. */
export type SurfaceEffect = Extract<WorkspaceEffect, {
  type: `browser.${string}` | `terminal.${string}` | "file.open" | "app.open-folder" | "app.check-for-updates" | "app.open-source-licenses" | "find-in-page"
    | "stop-find-in-page" | "focus-browser" | "find-in-terminal" | "stop-find-in-terminal";
}>;

export async function runSurfaceEffect(effect: SurfaceEffect, host: EffectHost): Promise<void> {
  const { desktop } = host;
  if (window.workspace?.owner && (effect.type === "terminal.close" || effect.type === "find-in-terminal" || effect.type === "stop-find-in-terminal")) {
    window.workspace.surface(effect);
    if (effect.type === "terminal.close") return reportFailure(host, desktop.closeTerminal(effect.terminalId));
    return;
  }
  switch (effect.type) {
    case "file.open":
      return reportFailure(host, desktop.openFile(effect.roots, effect.path, effect.line));

    case "app.open-folder":
      return reportFailure(host, desktop.openFolderInApp(effect.appId, effect.root));

    case "app.check-for-updates":
      return desktop.checkForUpdates();

    case "app.open-source-licenses":
      return reportFailure(host, desktop.openSourceLicenses());

    case "browser.open":
      return reportFailure(host, desktop.openBrowserTab(effect.tabId, effect.url));

    case "browser.navigate":
      return reportFailure(host, desktop.navigateBrowser(effect.tabId, effect.url));

    case "browser.history":
      return reportFailure(host, desktop.browserHistory(effect.tabId, effect.delta));

    case "browser.reload":
      return reportFailure(host, desktop.reloadBrowser(effect.tabId));

    case "browser.close":
      return reportFailure(host, desktop.closeBrowserTab(effect.tabId));

    case "browser.show":
      return reportFailure(host, desktop.showBrowserTab(effect.tabId));

    case "browser.act":
      return reportFailure(host, desktop.actInBrowser(effect.tabId, effect.action));

    case "browser.clear-data":
      return reportFailure(host, desktop.clearBrowserData());

    case "terminal.start":
      return reportFailure(host, desktop.startTerminal(effect.terminalId, { cwd: effect.cwd }));

    case "terminal.write":
      return reportFailure(host, desktop.writeTerminal(effect.terminalId, effect.data));

    case "terminal.resize":
      return reportFailure(host, desktop.resizeTerminal(effect.terminalId, effect.cols, effect.rows));

    /** The view outlives the panel, so the shell going is the only thing that takes it away. */
    case "terminal.close":
      disposeTerminalView(effect.terminalId);
      return reportFailure(host, desktop.closeTerminal(effect.terminalId));

    case "find-in-page":
      return reportFailure(host, desktop.findInPage(effect.tabId, effect.query, effect.forward, effect.findNext));

    case "stop-find-in-page":
      return reportFailure(host, desktop.stopFindInPage(effect.tabId));

    case "focus-browser":
      return reportFailure(host, desktop.focusBrowserTab(effect.tabId));

    case "find-in-terminal":
      searchTerminalView(effect.terminalId, effect.query, effect.forward);
      return;

    case "stop-find-in-terminal":
      clearTerminalSearch(effect.terminalId);
      return;
  }
}
