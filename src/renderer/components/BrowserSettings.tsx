import { useState } from "react";
import { ConfirmAction, SettingGroup, useRowListFocus } from "./SettingRow";
import { settingControl } from "../../domain/settings-catalog";
import { AvailabilitySection } from "./AvailabilitySection";
import { BrowserImportSection, type BrowserImportSettings } from "./BrowserImportSection";

export type BrowserSettingsProps = {
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** How many sites a run may open without asking, which clearing the session takes back. */
  allowedOrigins: string[];
  onSetBrowserTools: (enabled: boolean) => void;
  onClearBrowserData: () => void;
  /** Takes back one site, so the agent asks before it opens that site again. */
  onForgetOrigin?: (origin: string) => void;
  browserImport: BrowserImportSettings;
};

export function BrowserSettings({
  browserTools,
  allowedOrigins,
  onSetBrowserTools,
  onClearBrowserData,
  onForgetOrigin,
  browserImport,
}: BrowserSettingsProps) {
  const rows = useRowListFocus<HTMLDivElement>();
  const [removed, setRemoved] = useState<string | null>(null);
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Browser</h2>
        <p>The browser panel keeps one session for the whole app, so a site you sign into stays signed in everywhere AI Coding Tool works.</p>
      </div>

      <AvailabilitySection id="browser.availability" enabled={browserTools} onChange={onSetBrowserTools}
        description="The agent can open and read pages in the browser panel. Off leaves the panel to you alone." />

      <BrowserImportSection settings={browserImport} />

      <SettingGroup setting="browser.session" aria-labelledby="browser-session-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="browser-session-heading">{settingControl("browser.session").label}</h3>
            <p>Signing out clears every cookie, cache, and stored login, and takes back the sites the agent may open on its own.</p>
            <p role="status" className="settings-status done">{removed && `Removed ${removed}`}</p>
          </div>
          <div className="settings-group-action">
            <span>{allowedOrigins.length} {allowedOrigins.length === 1 ? "site allowed" : "sites allowed"}</span>
            <ConfirmAction className="danger" confirm="Sign out of everything" onConfirm={() => { setRemoved(null); onClearBrowserData(); }}>Clear browser data</ConfirmAction>
          </div>
        </div>

        {allowedOrigins.length === 0
          ? <p className="settings-empty">The agent has to ask before it opens any site.</p>
          : <div ref={rows.ref} onClickCapture={rows.onClickCapture}>
            {allowedOrigins.map((origin) => (
              <div className="setting-row plain" key={origin}>
                <strong className="setting-origin">{origin}</strong>
                {onForgetOrigin && (
                  <div className="setting-row-action">
                    <button type="button" aria-label={`Remove ${origin}`} onClick={() => { setRemoved(origin); onForgetOrigin(origin); }}>Remove</button>
                  </div>
                )}
              </div>
            ))}
          </div>}
      </SettingGroup>
    </main>
  );
}
