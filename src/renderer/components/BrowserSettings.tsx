import { SettingRowBase, useRowListFocus } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { ConfirmAction } from "../ui/ConfirmAction";
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
  return (
    <SettingsPage title="Browser" description="The browser panel keeps one session for the whole app, so a site you sign into stays signed in everywhere AI Coding Tool works.">
      <AvailabilitySection id="browser.availability" enabled={browserTools} onChange={onSetBrowserTools}
        description="The agent can open and read pages in the browser panel. Off leaves the panel to you alone." />

      <BrowserImportSection settings={browserImport} />

      <SettingsSection setting="browser.session" description="Signing out clears every cookie, cache, and stored login, and takes back the sites the agent may open on its own." action={<>
        <span>{allowedOrigins.length} {allowedOrigins.length === 1 ? "site allowed" : "sites allowed"}</span>
        <ConfirmAction variant="danger" confirm="Sign out of everything" onConfirm={onClearBrowserData}>Clear browser data</ConfirmAction>
      </>}>
        {allowedOrigins.length === 0
          ? <p className="settings-empty">The agent has to ask before it opens any site.</p>
          : <div ref={rows.ref} onClickCapture={rows.onClickCapture}>
            {allowedOrigins.map((origin) => (
              <SettingRowBase key={origin} title={<strong className="setting-origin">{origin}</strong>}>
                {onForgetOrigin && <Button aria-label={`Remove ${origin}`} onClick={() => onForgetOrigin(origin)}>Remove</Button>}
              </SettingRowBase>
            ))}
          </div>}
      </SettingsSection>
    </SettingsPage>
  );
}
