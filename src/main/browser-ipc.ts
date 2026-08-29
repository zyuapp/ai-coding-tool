import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { isBrowserAction, isBrowserBounds, isBrowserRead } from "../contracts/ipc.js";
import type { BrowserInspection } from "../domain/browser.js";
import * as browser from "./browser-host.js";

const MAX_URL_LENGTH = 8_192;
/** Longer than anything anyone searches for, and still bounded. */
const MAX_FIND_QUERY = 1_000;

function browserTabId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid browser tab ID.");
  return value;
}

export function browserPageUrl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) throw new Error("Invalid page URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The browser panel only opens web pages.");
  return value;
}

export function registerBrowserIpc(trusted: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle("browser:open", (event, tabId: unknown, url: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.openTab(browserTabId(tabId), url === undefined ? undefined : browserPageUrl(url));
  });

  ipcMain.handle("browser:navigate", (event, tabId: unknown, url: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.navigate(browserTabId(tabId), browserPageUrl(url));
  });

  ipcMain.handle("browser:history", (event, tabId: unknown, delta: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (delta !== 1 && delta !== -1) throw new Error("Invalid history step.");
    browser.goHistory(browserTabId(tabId), delta);
  });

  ipcMain.handle("browser:reload", (event, tabId: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.reload(browserTabId(tabId));
  });

  ipcMain.handle("browser:close", (event, tabId: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.closeTab(browserTabId(tabId));
  });

  ipcMain.handle("browser:show", (event, tabId: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.showTab(tabId === null ? null : browserTabId(tabId));
  });

  ipcMain.handle("browser:bounds", (event, bounds: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (bounds !== null && !isBrowserBounds(bounds)) throw new Error("Invalid panel bounds.");
    browser.setBounds(bounds);
  });

  ipcMain.handle("browser:act", (event, tabId: unknown, action: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (!isBrowserAction(action)) throw new Error("Invalid browser action.");
    return browser.act(browserTabId(tabId), action);
  });

  ipcMain.handle("browser:read", (event, tabId: unknown, textLimit: unknown, timeoutMs: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof textLimit !== "number" || typeof timeoutMs !== "number") throw new Error("Invalid page read.");
    return browser.readPage(browserTabId(tabId), textLimit, timeoutMs);
  });

  ipcMain.handle("browser:inspect", (event, tabId: unknown, inspection: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (!isBrowserRead(inspection) || !["console", "network", "wait"].includes(inspection.op) || "tabId" in inspection) {
      throw new Error("Invalid browser inspection.");
    }
    return browser.inspectPage(browserTabId(tabId), inspection as BrowserInspection);
  });

  ipcMain.handle("browser:capture", (event, tabId: unknown, fullPage: unknown, timeoutMs: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof fullPage !== "boolean" || typeof timeoutMs !== "number") throw new Error("Invalid page capture.");
    return browser.capturePage(browserTabId(tabId), fullPage, timeoutMs);
  });

  ipcMain.handle("browser:find", (event, tabId: unknown, query: unknown, forward: unknown, findNext: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof query !== "string" || !query || query.length > MAX_FIND_QUERY) throw new Error("Invalid search.");
    if (typeof forward !== "boolean" || typeof findNext !== "boolean") throw new Error("Invalid search.");
    browser.findInPage(browserTabId(tabId), query, { forward, findNext });
  });

  ipcMain.handle("browser:stop-find", (event, tabId: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.stopFindInPage(browserTabId(tabId));
  });

  ipcMain.handle("browser:focus", (event, tabId: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    browser.focusTab(browserTabId(tabId));
  });

  ipcMain.handle("browser:clear", (event) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    return browser.clearData();
  });
}
