import { useEffect, useMemo } from "react";
import { SettingGroup } from "./SettingRow";
import { settingControl } from "../../domain/settings-catalog";
import { LuCheck as Check, LuRotateCw as Again } from "react-icons/lu";
import { NO_BROWSER_IMPORT, sourceName, type BrowserImportPicker, type BrowserImportState } from "../../application/browser-import";
import type { BrowserImportSource } from "../../domain/browser-import";

/** A long list draws this many rows; searching reaches the rest. */
const SHOWN_SITES = 200;

export type BrowserImportSettings = {
  state: BrowserImportState;
  onRead: () => void;
  onChoose: (sourceId: string | null) => void;
  onToggle: (site: string) => void;
  onFilter: (text: string) => void;
  onRun: () => void;
  onAgain: () => void;
};

export const NO_BROWSER_IMPORT_SETTINGS: BrowserImportSettings = {
  state: NO_BROWSER_IMPORT,
  onRead() {}, onChoose() {}, onToggle() {}, onFilter() {}, onRun() {}, onAgain() {},
};

function SitePicker({ picker, importing, onToggle, onFilter, onRun, onCancel }: {
  picker: BrowserImportPicker;
  importing: boolean;
  onToggle: (site: string) => void;
  onFilter: (text: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const query = picker.filter.trim().toLowerCase();
  const matching = useMemo(() => (picker.sites ?? []).filter((site) => site.domain.includes(query)), [picker.sites, query]);
  const selected = new Set(picker.selected);
  const count = picker.selected.length;

  return (
    <div className="browser-import-picker">
      {picker.sites === null
        ? <p className="browser-import-quiet">Reading sites…</p>
        : picker.sites.length === 0
          ? <p className="browser-import-quiet">This profile holds no sign-ins.</p>
          : <>
              <input type="search" autoFocus aria-label="Find a site" placeholder="Find a site…" value={picker.filter}
                onInput={(event) => onFilter(event.currentTarget.value)} />
              <div className="browser-import-sites" role="group" aria-label="Sites">
                {matching.slice(0, SHOWN_SITES).map((site) => (
                  <label key={site.domain}>
                    <input type="checkbox" checked={selected.has(site.domain)} onChange={() => onToggle(site.domain)} />
                    <span>{site.domain}</span>
                    <em>{site.cookies} {site.cookies === 1 ? "cookie" : "cookies"}</em>
                  </label>
                ))}
                {matching.length === 0 && <p className="browser-import-quiet">No site matches.</p>}
              </div>
              {matching.length > SHOWN_SITES && <p className="browser-import-quiet">Showing {SHOWN_SITES} of {matching.length}. Search to find the rest.</p>}
            </>}
      <div className="browser-import-actions">
        <button type="button" onClick={onCancel} disabled={importing}>Cancel</button>
        <button type="button" className="primary" onClick={onRun} disabled={importing || count === 0}>
          {importing ? "Importing…" : count === 0 ? "Import" : `Import ${count} ${count === 1 ? "site" : "sites"}`}
        </button>
      </div>
    </div>
  );
}

function SourceRow({ source, sources, settings }: { source: BrowserImportSource; sources: BrowserImportSource[]; settings: BrowserImportSettings }) {
  const { state } = settings;
  const picking = state.picker?.sourceId === source.id;
  const last = state.last?.sourceId === source.id ? state.last : null;
  const shown = sources.filter((item) => item.browser === source.browser).length > 1;
  return (
    <>
      <div className="setting-row browser-import-source">
        <span className={`setting-status ${last ? "granted" : "blank"}`}>{last && <Check size={13} />}</span>
        <div>
          <strong>{shown ? sourceName(source, sources) : source.browser}</strong>
          {last && <p>Last imported {last.sites.length === 1 ? last.sites[0] : `${last.sites.length} sites`}.</p>}
        </div>
        {!picking && (
          <div className="setting-row-action">
            {last && <button type="button" onClick={settings.onAgain} disabled={state.importing}><Again size={12} /> {state.importing ? "Importing…" : "Import again"}</button>}
            <button type="button" onClick={() => settings.onChoose(source.id)} disabled={state.importing}>Choose sites</button>
          </div>
        )}
      </div>
      {picking && state.picker && (
        <SitePicker picker={state.picker} importing={state.importing} onToggle={settings.onToggle} onFilter={settings.onFilter}
          onRun={settings.onRun} onCancel={() => settings.onChoose(null)} />
      )}
    </>
  );
}

/** Copies another browser's sign-ins for the sites the user picks, and repeats that on request. */
export function BrowserImportSection({ settings }: { settings: BrowserImportSettings }) {
  const { state, onRead } = settings;
  useEffect(() => { onRead(); }, []);

  return (
    <SettingGroup setting="browser.import" aria-labelledby="browser-import-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="browser-import-heading">{settingControl("browser.import").label}</h3>
          <p>Copy sign-ins from another browser for the sites you pick. Passwords are never copied.</p>
        </div>
      </div>

      {state.notice && <p className="browser-import-notice" role="status">{state.notice}</p>}
      {state.error && <p className="settings-error" role="alert">{state.error}</p>}

      {state.sources === null
        ? <p className="settings-empty">Looking for browsers…</p>
        : state.sources.length === 0
          ? <p className="settings-empty">No other browsers found on this computer.</p>
          : state.sources.map((source) => <SourceRow key={source.id} source={source} sources={state.sources!} settings={settings} />)}
    </SettingGroup>
  );
}
