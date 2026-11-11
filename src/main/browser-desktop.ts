import type { BrowserPort } from "../contracts/browser-port.js";
import type * as BrowserHost from "./browser-host.js";
import type * as BrowserImport from "./browser-import.js";
import type { DesktopEvents } from "./desktop-events.js";
import { needsDesktop, unsubscribed } from "./headless.js";

/** The browser panel's pages, driven from this process. */
export function browserDesktop(browser: typeof BrowserHost, imports: typeof BrowserImport, events: DesktopEvents, openFullDiskAccess: () => Promise<void>): BrowserPort["runtime"] {
  /** A read macOS refused opens the setting that allows it. */
  const reading = <T>(work: Promise<T>) => work.catch((error: unknown) => {
    if (error instanceof imports.BrowserDataBlocked) void openFullDiskAccess().catch(() => undefined);
    throw error;
  });
  return {
    configureBrowserPermissions: async (permissions) => browser.configurePermissions(permissions),
    openBrowserTab: async (tabId, url, taskId) => browser.openTab(tabId, url, taskId),
    navigateBrowser: async (tabId, url, taskId) => browser.navigate(tabId, url, taskId),
    browserHistory: async (tabId, delta, taskId) => browser.goHistory(tabId, delta, taskId),
    reloadBrowser: async (tabId, taskId) => browser.reload(tabId, taskId),
    closeBrowserTab: async (tabId) => browser.closeTab(tabId),
    showBrowserTab: async (tabId) => browser.showTab(tabId),
    actInBrowser: (tabId, action, taskId) => browser.act(tabId, action, taskId),
    readBrowserPage: (tabId, textLimit, timeoutMs, taskId) => browser.readPage(tabId, textLimit, timeoutMs, taskId),
    inspectBrowserPage: (tabId, inspection, taskId) => browser.inspectPage(tabId, inspection, taskId),
    captureBrowserPage: (tabId, fullPage, timeoutMs, taskId) => browser.capturePage(tabId, fullPage, timeoutMs, taskId),
    clearBrowserData: () => browser.clearData(),
    listBrowserImportSources: () => imports.listImportSources(),
    listBrowserImportSites: (sourceId) => reading(imports.listImportSites(sourceId)),
    importBrowserSites: (sourceId, sites) => reading(imports.importBrowserSites(sourceId, sites, browser.replaceCookies)),
    onBrowserEvent: (listener) => events.on("browser:event", listener),
    findInPage: async (tabId, query, forward, findNext) => browser.findInPage(tabId, query, { forward, findNext }),
    stopFindInPage: async (tabId) => browser.stopFindInPage(tabId),
    focusBrowserTab: async (tabId) => browser.focusTab(tabId),
    onBrowserFind: (listener) => events.on("browser:find", listener),
  };
}

/** No panel is drawn: reads find no page, and what would open one is refused. */
export const headlessBrowserDesktop: BrowserPort["runtime"] = {
  configureBrowserPermissions: async () => {},
  openBrowserTab: needsDesktop("The browser panel"),
  navigateBrowser: needsDesktop("The browser panel"),
  browserHistory: needsDesktop("The browser panel"),
  reloadBrowser: needsDesktop("The browser panel"),
  closeBrowserTab: async () => {},
  showBrowserTab: async () => {},
  actInBrowser: needsDesktop("The browser panel"),
  readBrowserPage: async () => null,
  inspectBrowserPage: async () => null,
  captureBrowserPage: async () => null,
  clearBrowserData: async () => {},
  listBrowserImportSources: async () => [],
  listBrowserImportSites: async () => [],
  importBrowserSites: needsDesktop("The browser panel"),
  onBrowserEvent: unsubscribed,
  findInPage: async () => {},
  stopFindInPage: async () => {},
  focusBrowserTab: async () => {},
  onBrowserFind: unsubscribed,
};
