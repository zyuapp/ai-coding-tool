import type { BrowserAction, BrowserBounds, BrowserInspection, BrowserInspectionResult, BrowserPermissions, BrowserShot, BrowserSnapshot } from "../domain/browser.js";
import type { BrowserImportResult, BrowserImportSite, BrowserImportSource } from "../domain/browser-import.js";
import type { BrowserFindEvent, BrowserPageEvent } from "./ipc.js";

/** The browser panel's pages live in main; the window owns the record of them and their geometry. */
type BrowserRuntime = {
  configureBrowserPermissions(permissions: BrowserPermissions): Promise<void>;
  openBrowserTab(tabId: string, url?: string, taskId?: string): Promise<void>;
  navigateBrowser(tabId: string, url: string, taskId?: string): Promise<void>;
  browserHistory(tabId: string, delta: -1 | 1, taskId?: string): Promise<void>;
  reloadBrowser(tabId: string, taskId?: string): Promise<void>;
  closeBrowserTab(tabId: string): Promise<void>;
  /** Which tab the panel is showing. */
  showBrowserTab(tabId: string | null): Promise<void>;
  actInBrowser(tabId: string, action: BrowserAction, taskId?: string): Promise<string>;
  /** Waits for the tab to stop loading, then reads the page. Null when that tab is gone. */
  readBrowserPage(tabId: string, textLimit: number, timeoutMs: number, taskId?: string): Promise<BrowserSnapshot | null>;
  /** Reads recent diagnostics or waits for a condition in one page. */
  inspectBrowserPage(tabId: string, inspection: BrowserInspection, taskId?: string): Promise<BrowserInspectionResult | null>;
  /** Waits the same way, then writes a picture of the page to a file. Null when that tab is gone. */
  captureBrowserPage(tabId: string, fullPage: boolean, timeoutMs: number, taskId?: string): Promise<BrowserShot | null>;
  clearBrowserData(): Promise<void>;
  /** Other browsers' profiles on this machine, the sites one holds cookies for, and copying those cookies in. */
  listBrowserImportSources(): Promise<BrowserImportSource[]>;
  listBrowserImportSites(sourceId: string): Promise<BrowserImportSite[]>;
  importBrowserSites(sourceId: string, sites: string[]): Promise<BrowserImportResult>;
  onBrowserEvent(listener: (event: BrowserPageEvent) => void): () => void;
  /** Searching a page. Chromium holds the text and counts the matches, so it reports them back. */
  findInPage(tabId: string, query: string, forward: boolean, findNext: boolean): Promise<void>;
  stopFindInPage(tabId: string): Promise<void>;
  focusBrowserTab(tabId: string): Promise<void>;
  onBrowserFind(listener: (event: BrowserFindEvent) => void): () => void;
};

export type BrowserPort = {
  runtime: BrowserRuntime;
  windowCalls: Pick<BrowserRuntime, "focusBrowserTab"> & {
    /** Where the panel is, in window coordinates. Null while the panel is not on screen. */
    setBrowserBounds(bounds: BrowserBounds | null): Promise<void>;
  };
};
