import type { BrowserApproval } from "../../domain/browser.js";
import { NO_BROWSER_IMPORT, type BrowserImportState } from "../browser-import.js";

export type BrowserState = {
  /** The origins a run may reach without asking. Visiting a site adds it. */
  browserOrigins: string[];
  browserImport: BrowserImportState;
  browserApproval: BrowserApproval | null;
};

export function initialBrowserState(): BrowserState {
  return { browserOrigins: [], browserImport: NO_BROWSER_IMPORT, browserApproval: null };
}
