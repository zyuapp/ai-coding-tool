import { Check } from "lucide-react";
import { AvailabilitySection } from "./AvailabilitySection";

export type BrowserSettingsProps = {
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** How many sites a run may open without asking, which clearing the session takes back. */
  allowedOrigins: string[];
  /** Whether signing out is one press away from happening. */
  confirming: boolean;
  confirmationRef: React.RefObject<HTMLButtonElement | null>;
  clearRef: React.RefObject<HTMLButtonElement | null>;
  onSetBrowserTools: (enabled: boolean) => void;
  onClearBrowserData: () => void;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
};

export function BrowserSettings({
  browserTools,
  allowedOrigins,
  confirming,
  confirmationRef,
  clearRef,
  onSetBrowserTools,
  onClearBrowserData,
  onStartConfirm,
  onCancelConfirm,
}: BrowserSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Browser</h2>
        <p>The browser panel keeps one session for the whole app, so a site you sign into stays signed in everywhere AI Coding Tool works.</p>
      </div>

      <AvailabilitySection id="browser-tools" label="Browser use" enabled={browserTools} onChange={onSetBrowserTools}
        description="Claude can open and read pages in the browser panel. Off leaves the panel to you alone." />

      <section className="settings-group" aria-labelledby="browser-session-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="browser-session-heading">Session</h3>
            <p>Signing out clears every cookie, cache, and stored login, and takes back the sites Claude may open on its own.</p>
          </div>
          <div className="settings-group-action">
            <span>{allowedOrigins.length} {allowedOrigins.length === 1 ? "site allowed" : "sites allowed"}</span>
            {confirming
              ? <>
                  <button ref={confirmationRef} className="danger" type="button" onClick={() => {
                    onClearBrowserData();
                    onCancelConfirm();
                  }}>Sign out of everything</button>
                  <button type="button" onClick={onCancelConfirm}>Cancel</button>
                </>
              : <button ref={clearRef} type="button" onClick={onStartConfirm}>Clear browser data</button>}
          </div>
        </div>

        {allowedOrigins.length === 0
          ? <p className="settings-empty">Claude has to ask before it opens any site.</p>
          : allowedOrigins.map((origin) => (
            <div className="setting-row" key={origin}>
              <span className="setting-status granted"><Check size={13} /></span>
              <div>
                <strong>{origin}</strong>
                <p>Claude can open this site without asking.</p>
              </div>
            </div>
          ))}
      </section>
    </main>
  );
}
