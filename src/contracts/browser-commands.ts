import type { BrowserAction } from "../domain/browser.js";
import { isImportSite, isImportSourceId } from "../domain/browser-import.js";
import { agentId, boolean, nullable, optionalBoolean, optionalText, step, text, type Declarations } from "./command-declaration.js";
import { isBrowserAction, isString, MAX_URL_LENGTH } from "./ipc.js";

/**
 * The browser panel, which holds one session for the whole app rather than one per project or thread.
 * A command carrying a `taskId` is a run asking; the user's own commands carry none, and visiting a
 * site is the consent that lets a run reach that origin afterwards.
 */
export type BrowserCommand =
  | { type: "browser.open"; taskId?: string; url: string; tabId?: string; newTab?: boolean }
  /** An empty tab, waiting for an address. Only the user opens one; a run always names a page. */
  | { type: "browser.new-tab" }
  | { type: "browser.close-tab"; taskId?: string; tabId: string }
  | { type: "browser.select-tab"; taskId?: string; tabId: string }
  | { type: "browser.go"; taskId?: string; tabId?: string; delta: -1 | 1 }
  | { type: "browser.reload"; taskId?: string; tabId?: string }
  | { type: "browser.act"; taskId?: string; tabId?: string; action: BrowserAction }
  /** Answers the navigation a run is waiting on. Allowing it also allows that origin from now on. */
  | { type: "browser.decide"; allow: boolean; approvalId: string }
  /** Signs the whole app out: cookies, storage, and caches for every site. */
  | { type: "browser.clear-data" };

/**
 * Copies another browser's cookies for the sites the user picks into the browser panel. Only the
 * user imports, so none of these appear in `ExternalCommand`.
 */
export type BrowserImportCommand =
  /** Looks for the browser profiles on this machine. */
  | { type: "browser-import.read" }
  /** Opens one profile's sites to pick from, or closes the list with null. */
  | { type: "browser-import.choose"; sourceId: string | null }
  | { type: "browser-import.toggle"; site: string }
  | { type: "browser-import.filter"; text: string }
  | { type: "browser-import.run" }
  /** Repeats the last import, reading fresh cookies for the same sites. */
  | { type: "browser-import.again" };

/** A run drives the browser as itself, so every browser command names the thread that asked. */
function drivesBrowser(command: { taskId?: string; tabId?: string; url?: string }): boolean {
  return isString(command.taskId) && agentId(command.tabId) && (command.url === undefined || isString(command.url, MAX_URL_LENGTH));
}

export const browserCommands = {
  "browser.open": { fields: { taskId: optionalText, url: text, tabId: optionalText, newTab: optionalBoolean }, at: "panel", agent: drivesBrowser },
  "browser.new-tab": { fields: {}, at: "panel" },
  "browser.close-tab": { fields: { taskId: optionalText, tabId: text }, at: "panel", agent: drivesBrowser },
  "browser.select-tab": { fields: { taskId: optionalText, tabId: text }, at: "panel", agent: drivesBrowser },
  "browser.go": { fields: { taskId: optionalText, tabId: optionalText, delta: step }, at: "panel", agent: drivesBrowser },
  "browser.reload": { fields: { taskId: optionalText, tabId: optionalText }, at: "panel", agent: drivesBrowser },
  "browser.act": { fields: { taskId: optionalText, tabId: optionalText, action: isBrowserAction }, at: "panel", agent: drivesBrowser },
  "browser.decide": { fields: { allow: boolean, approvalId: text }, at: "panel" },
  "browser.clear-data": { fields: {}, at: "panel" },
} satisfies Declarations<BrowserCommand>;

export const browserImportCommands = {
  "browser-import.read": { fields: {}, at: "local" },
  "browser-import.choose": { fields: { sourceId: nullable(isImportSourceId) }, at: "local" },
  "browser-import.toggle": { fields: { site: isImportSite }, at: "local" },
  "browser-import.filter": { fields: { text: (value): value is string => typeof value === "string" && value.length <= 256 }, at: "local" },
  "browser-import.run": { fields: {}, at: "local" },
  "browser-import.again": { fields: {}, at: "local" },
} satisfies Declarations<BrowserImportCommand>;
