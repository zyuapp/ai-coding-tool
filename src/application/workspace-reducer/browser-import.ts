/** Copying sign-ins from another browser on this machine into the browser panel. */
import { persistView } from "./dock-tabs.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";
import { importNotice, sourceName, type BrowserImportState } from "../browser-import.js";
import { MAX_IMPORT_SITES } from "../../domain/browser-import.js";

type BrowserImportInput = Extract<WorkspaceInput, { type: `browser-import.${string}` }>;

function patch(state: WorkspaceState, change: Partial<BrowserImportState>): WorkspaceState {
  return { ...state, browserImport: { ...state.browserImport, ...change } };
}

export function reduceBrowserImport(state: WorkspaceState, input: BrowserImportInput): WorkspaceTransition {
  const current = state.browserImport;
  const picker = current.picker;
  switch (input.type) {
    case "browser-import.read":
      return settled(state, [{ type: "browser-import.list-sources" }]);

    case "browser-import.sources": {
      const kept = picker && input.sources.some((source) => source.id === picker.sourceId) ? picker : null;
      return settled(patch(state, { sources: input.sources, picker: kept }));
    }

    case "browser-import.choose": {
      if (input.sourceId === null) return settled(patch(state, { picker: null }));
      if (!current.sources?.some((source) => source.id === input.sourceId)) return settled(state);
      const selected = current.last?.sourceId === input.sourceId ? current.last.sites : [];
      return settled(
        patch(state, { picker: { sourceId: input.sourceId, sites: null, selected, filter: "" }, notice: null, error: null }),
        [{ type: "browser-import.list-sites", sourceId: input.sourceId }],
      );
    }

    case "browser-import.sites": {
      if (picker?.sourceId !== input.sourceId) return settled(state);
      const offered = new Set(input.sites.map((site) => site.domain));
      return settled(patch(state, { picker: { ...picker, sites: input.sites, selected: picker.selected.filter((site) => offered.has(site)) } }));
    }

    case "browser-import.toggle": {
      if (!picker?.sites?.some((site) => site.domain === input.site)) return settled(state);
      const on = picker.selected.includes(input.site);
      if (!on && picker.selected.length >= MAX_IMPORT_SITES) return settled(state);
      const selected = on ? picker.selected.filter((site) => site !== input.site) : [...picker.selected, input.site];
      return settled(patch(state, { picker: { ...picker, selected } }));
    }

    case "browser-import.filter":
      return picker ? settled(patch(state, { picker: { ...picker, filter: input.text } })) : settled(state);

    case "browser-import.run":
    case "browser-import.again": {
      const target = input.type === "browser-import.run" ? picker && { sourceId: picker.sourceId, sites: picker.selected } : current.last;
      if (current.importing || !target?.sites.length) return settled(state);
      return settled(
        patch(state, { importing: true, notice: null, error: null }),
        [{ type: "browser-import.import", sourceId: target.sourceId, sites: target.sites }],
      );
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
      return settled(done, failed ? [] : persistView(done));
    }

    case "browser-import.failed":
      return settled(patch(state, {
        importing: false,
        /** A list that never arrived leaves nothing to pick from. */
        picker: picker?.sites === null ? null : picker,
        error: input.message,
      }));
  }
}
