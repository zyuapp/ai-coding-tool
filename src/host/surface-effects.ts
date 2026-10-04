import { reportFailure, type EffectHandlers, type EffectHost } from "./effect-host.js";
import { errorMessage } from "./errors.js";

/** A failed import step is reported beside the import, not in the workspace error banner. */
async function importing(host: EffectHost, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    await host.dispatch({ type: "browser-import.failed", message: errorMessage(error) });
  }
}

/** The panels that hold something of their own: pages, shells, and the files opened out of them. */
export const surfaceEffects = {
  "image.download": (effect, host) => reportFailure(host, host.desktop.downloadImage(effect.source)),

  "file.open": (effect, host) => reportFailure(host, host.desktop.openFile(effect.roots, effect.path, effect.line)),

  /** An application scan that fails leaves the menu with nothing to offer rather than an error. */
  "app.list": async (_effect, { dispatch, desktop }) => {
    await dispatch({ type: "apps.listed", apps: await desktop.listApps().catch(() => []) });
  },

  "app.open-folder": (effect, host) => reportFailure(host, host.desktop.openFolderInApp(effect.appId, effect.root)),

  "app.check-for-updates": (_effect, { desktop }) => desktop.checkForUpdates(),

  "app.download-update": (_effect, { desktop }) => desktop.downloadUpdate(),

  "app.install-update": (_effect, { desktop }) => desktop.installUpdate(),

  "app.open-source-licenses": (_effect, host) => reportFailure(host, host.desktop.openSourceLicenses()),

  "browser.permissions": (effect, host) => reportFailure(host, host.desktop.configureBrowserPermissions(effect.permissions)),

  "browser.open": (effect, host) => reportFailure(host, host.desktop.openBrowserTab(effect.tabId, effect.url, effect.taskId)),

  "browser.navigate": (effect, host) => reportFailure(host, host.desktop.navigateBrowser(effect.tabId, effect.url, effect.taskId)),

  "browser.history": (effect, host) => reportFailure(host, host.desktop.browserHistory(effect.tabId, effect.delta, effect.taskId)),

  "browser.reload": (effect, host) => reportFailure(host, host.desktop.reloadBrowser(effect.tabId, effect.taskId)),

  "browser.close": (effect, host) => reportFailure(host, host.desktop.closeBrowserTab(effect.tabId)),

  "browser.show": (effect, host) => reportFailure(host, host.desktop.showBrowserTab(effect.tabId)),

  "browser.act": (effect, host) => reportFailure(host, host.desktop.actInBrowser(effect.tabId, effect.action, effect.taskId)),

  "browser.clear-data": (_effect, host) => reportFailure(host, host.desktop.clearBrowserData()),

  "browser-import.list-sources": (_effect, host) => importing(host, async () => {
    await host.dispatch({ type: "browser-import.sources", sources: await host.desktop.listBrowserImportSources() });
  }),

  "browser-import.list-sites": (effect, host) => importing(host, async () => {
    await host.dispatch({ type: "browser-import.sites", sourceId: effect.sourceId, sites: await host.desktop.listBrowserImportSites(effect.sourceId) });
  }),

  "browser-import.import": (effect, host) => importing(host, async () => {
    const result = await host.desktop.importBrowserSites(effect.sourceId, effect.sites);
    await host.dispatch({ type: "browser-import.done", sourceId: effect.sourceId, sites: effect.sites, result });
  }),

  "terminal.start": (effect, host) => reportFailure(host, host.desktop.startTerminal(effect.terminalId, { cwd: effect.cwd })),

  "terminal.write": (effect, host) => reportFailure(host, host.desktop.writeTerminal(effect.terminalId, effect.data)),

  "terminal.resize": (effect, host) => reportFailure(host, host.desktop.resizeTerminal(effect.terminalId, effect.cols, effect.rows)),

  /** The view outlives the panel, so the shell going is the only thing that takes it away. */
  "terminal.close": (effect, host) => {
    host.surface?.(effect);
    return reportFailure(host, host.desktop.closeTerminal(effect.terminalId));
  },

  "find-in-page": (effect, host) => reportFailure(host, host.desktop.findInPage(effect.tabId, effect.query, effect.forward, effect.findNext)),

  "stop-find-in-page": (effect, host) => reportFailure(host, host.desktop.stopFindInPage(effect.tabId)),

  "focus-browser": (effect, host) => reportFailure(host, host.desktop.focusBrowserTab(effect.tabId)),

  "find-in-terminal": (effect, host) => { host.surface?.(effect); },

  "stop-find-in-terminal": (effect, host) => { host.surface?.(effect); },
} satisfies Partial<EffectHandlers>;
