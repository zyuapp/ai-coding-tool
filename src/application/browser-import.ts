import type { BrowserImportMemory, BrowserImportResult, BrowserImportSite, BrowserImportSource } from "../domain/browser-import.js";

/** The sites one profile offers, and which of them the user has ticked. `sites` is null while being read. */
export type BrowserImportPicker = {
  sourceId: string;
  sites: BrowserImportSite[] | null;
  selected: string[];
  filter: string;
};

/** Copying sign-ins from another browser on this machine into the browser panel. */
export type BrowserImportState = {
  /** The profiles found, or null before settings has looked. */
  sources: BrowserImportSource[] | null;
  picker: BrowserImportPicker | null;
  importing: boolean;
  notice: string | null;
  error: string | null;
  /** The import "Import again" repeats. Survives a restart. */
  last: BrowserImportMemory | null;
};

export const NO_BROWSER_IMPORT: BrowserImportState = { sources: null, picker: null, importing: false, notice: null, error: null, last: null };

export function sourceName(source: BrowserImportSource | undefined, sources: BrowserImportSource[]) {
  if (!source) return "that browser";
  return sources.filter((item) => item.browser === source.browser).length > 1 ? `${source.browser} (${source.profile})` : source.browser;
}

export function importNotice(result: BrowserImportResult, sites: string[], from: string) {
  const where = sites.length === 1 ? sites[0] : `${sites.length} sites`;
  const copied = `Copied ${result.imported} ${result.imported === 1 ? "cookie" : "cookies"} for ${where} from ${from}.`;
  return result.skipped ? `${copied} ${result.skipped} could not be read.` : copied;
}
