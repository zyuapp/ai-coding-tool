/** Copying sign-ins from another browser on this machine into the browser panel. */
import type { SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import type { BrowserState } from "../state/browser.js";
import { importNotice, sourceName, type BrowserImportState } from "../browser-import.js";
import { MAX_IMPORT_SITES } from "../../domain/browser-import.js";
import type { BrowserImportResult, BrowserImportSite, BrowserImportSource } from "../../domain/browser-import.js";

export const BROWSER_IMPORT_INPUTS = [
  "browser-import.read", "browser-import.sources", "browser-import.choose", "browser-import.sites", "browser-import.toggle",
  "browser-import.filter", "browser-import.run", "browser-import.again", "browser-import.done", "browser-import.failed"
] as const;
type BrowserImportInput = Extract<WorkspaceInput, { type: (typeof BROWSER_IMPORT_INPUTS)[number] }>;

export type BrowserImportEvent =
  | { type: "browser-import.sources"; sources: BrowserImportSource[] }
  | { type: "browser-import.sites"; sourceId: string; sites: BrowserImportSite[] }
  | { type: "browser-import.done"; sourceId: string; sites: string[]; result: BrowserImportResult }
  | { type: "browser-import.failed"; message: string };

export type BrowserImportEffect =
  | { type: "browser-import.list-sources" }
  | { type: "browser-import.list-sites"; sourceId: string }
  | { type: "browser-import.import"; sourceId: string; sites: string[] };

type Own = Pick<BrowserState, "browserImport">;

function patch(state: Own, change: Partial<BrowserImportState>): SliceTransition<Own>["patch"] {
  return { browserImport: { ...state.browserImport, ...change } };
}

export function reduceBrowserImport(state: Own, input: BrowserImportInput): SliceTransition<Own> {
  const current = state.browserImport;
  const picker = current.picker;
  switch (input.type) {
    case "browser-import.read":
      return { effects: [{ type: "browser-import.list-sources" }] };

    case "browser-import.sources": {
      const kept = picker && input.sources.some((source) => source.id === picker.sourceId) ? picker : null;
      return { patch: patch(state, { sources: input.sources, picker: kept }) };
    }

    case "browser-import.choose": {
      if (input.sourceId === null) return { patch: patch(state, { picker: null }) };
      if (!current.sources?.some((source) => source.id === input.sourceId)) return {};
      const selected = current.last?.sourceId === input.sourceId ? current.last.sites : [];
      return {
        patch: patch(state, { picker: { sourceId: input.sourceId, sites: null, selected, filter: "" }, notice: null, error: null }),
        effects: [{ type: "browser-import.list-sites", sourceId: input.sourceId }],
      };
    }

    case "browser-import.sites": {
      if (picker?.sourceId !== input.sourceId) return {};
      const offered = new Set(input.sites.map((site) => site.domain));
      return { patch: patch(state, { picker: { ...picker, sites: input.sites, selected: picker.selected.filter((site) => offered.has(site)) } }) };
    }

    case "browser-import.toggle": {
      if (!picker?.sites?.some((site) => site.domain === input.site)) return {};
      const on = picker.selected.includes(input.site);
      if (!on && picker.selected.length >= MAX_IMPORT_SITES) return {};
      const selected = on ? picker.selected.filter((site) => site !== input.site) : [...picker.selected, input.site];
      return { patch: patch(state, { picker: { ...picker, selected } }) };
    }

    case "browser-import.filter":
      return picker ? { patch: patch(state, { picker: { ...picker, filter: input.text } }) } : {};

    case "browser-import.run":
    case "browser-import.again": {
      const target = input.type === "browser-import.run" ? picker && { sourceId: picker.sourceId, sites: picker.selected } : current.last;
      if (current.importing || !target?.sites.length) return {};
      return {
        patch: patch(state, { importing: true, notice: null, error: null }),
        effects: [{ type: "browser-import.import", sourceId: target.sourceId, sites: target.sites }],
      };
    }

    case "browser-import.done": {
      const sources = current.sources ?? [];
      const from = sourceName(sources.find((source) => source.id === input.sourceId), sources);
      const failed = input.result.imported === 0;
      const done = patch(state, {
        importing: false,
        picker: failed ? picker : null,
        notice: failed ? null : importNotice(input.result, input.sites, from),
        error: failed ? `No cookies could be copied from ${from}.` : null,
        last: failed ? current.last : { sourceId: input.sourceId, sites: input.sites },
      });
      return failed ? { patch: done } : { patch: done, persists: true };
    }

    case "browser-import.failed":
      return { patch: patch(state, {
        importing: false,
        /** A list that never arrived leaves nothing to pick from. */
        picker: picker?.sites === null ? null : picker,
        error: input.message,
      }) };
  }
}
