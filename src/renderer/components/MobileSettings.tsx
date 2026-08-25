import { Check, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { addressOrigin, type MobileAddress, type MobileConnectionState, type MobilePairingOffer, type MobileServerState, type MobileSessionView, type PairedDeviceView, type TailscaleState } from "../../domain/mobile";

function statusLabel(remote: MobileServerState): string {
  if (!remote.enabled) return "Off";
  switch (remote.status) {
    case "listening": return "Listening";
    case "starting": return "Starting…";
    case "error": return "Failed to start";
    default: return "Off";
  }
}

function addressOf(remote: MobileServerState, kind: MobileAddress["kind"]): MobileAddress | null {
  return remote.addresses.find((address) => address.kind === kind) ?? null;
}

function tailscaleMessage(tailscale: TailscaleState): string {
  switch (tailscale.status) {
    case "ready": {
      if (!tailscale.certs) return "Signed in. This tailnet issues no HTTPS certificate. Turn HTTPS on in the Tailscale admin console, under DNS.";
      return tailscale.magicDnsName ? `Signed in as ${tailscale.magicDnsName}.` : "Signed in.";
    }
    case "missing": return "Not installed. Install Tailscale to reach this Mac from outside the network.";
    case "logged-out": return "Installed, but signed out. Sign in to Tailscale first.";
    default: return "Looking for Tailscale…";
  }
}

/** Milliseconds left on the code, floored at zero. */
function useCountdown(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === null ? 0 : Math.max(0, expiresAt - now);
}

function countdownLabel(remaining: number): string {
  const seconds = Math.ceil(remaining / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The pairing URL as a QR image, redrawn when the URL changes. */
function useQrCode(url: string | null): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void toDataURL(url, { margin: 1, scale: 6, errorCorrectionLevel: "M" })
      .then((drawn) => { if (!cancelled) setImage(drawn); })
      .catch(() => { if (!cancelled) setImage(null); });
    return () => { cancelled = true; };
  }, [url]);
  return image;
}

function connectionLabel(connection: MobileConnectionState): string {
  if (connection === "live") return "Live.";
  return connection === "resuming" ? "Catching up…" : "Reconnecting…";
}

function lastSeenLabel(device: PairedDeviceView): string {
  if (device.lastSeenAt === null) return "Never connected.";
  const days = Math.floor((Date.now() - device.lastSeenAt) / 86_400_000);
  if (days === 0) return "Seen today.";
  return days === 1 ? "Seen yesterday." : `Seen ${days} days ago.`;
}

/** The QR and the code beside it, live only while an unspent code has time left on it. */
function PairingSection({ pairing, listening, onCreatePairingCode }: { pairing: MobilePairingOffer | null; listening: boolean; onCreatePairingCode: () => void }) {
  const remaining = useCountdown(pairing?.expiresAt ?? null);
  const live = pairing !== null && remaining > 0;
  const qr = useQrCode(live ? pairing.url : null);
  return (
    <section className="settings-group" aria-labelledby="phone-pairing-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-pairing-heading">Pairing</h3>
          <p>Scan this with the phone's camera. The code works once and expires in two minutes.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={!listening} onClick={onCreatePairingCode}>{live ? "New code" : "Show a code"}</button>
        </div>
      </div>

      {!listening && <p className="settings-empty">Turn phone access on to pair a phone.</p>}
      {listening && !live && <p className="settings-empty">No code on screen.</p>}
      {listening && live && (
        <div className="phone-pairing">
          {qr
            ? <img className="phone-qr" src={qr} alt={`QR code for ${pairing.url}`} />
            : <div className="phone-qr placeholder" aria-hidden="true" />}
          <div className="phone-pairing-copy">
            <strong>{pairing.code}</strong>
            <p>Expires in {countdownLabel(remaining)}.</p>
            <code>{pairing.url}</code>
            {pairing.address.kind === "loopback" && (
              <p className="phone-pairing-warning">This address points at the phone itself. Turn on a way in above, then ask for a new code.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One way in: its state, its trade-off, and the address it serves. */
function Route({ id, name, on, summary, address, note, action, disabled, chosen, onToggle }: {
  id: string;
  name: string;
  on: boolean;
  summary: string;
  address: MobileAddress | null;
  note: string;
  action?: React.ReactNode;
  disabled: boolean;
  chosen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="phone-route" data-route={id}>
      <div className="setting-row">
        <span className={`setting-status ${on ? "granted" : ""}`}>{on && <Check size={13} />}</span>
        <div>
          <strong>{name}{chosen && <em className="phone-route-chosen">In the QR code</em>}</strong>
          <p>{summary}</p>
        </div>
        <div className="setting-row-action">
          {action}
          <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onToggle}>{on ? "Turn off" : "Turn on"}</button>
        </div>
      </div>
      <p className="phone-route-note">{note}</p>
      {on && address && <code className="phone-route-address">{addressOrigin(address)}</code>}
    </div>
  );
}

function RouteSection({ remote, listening, onSetLanExposed, onSetTailscaleServe, onRefreshTailscale }: {
  remote: MobileServerState;
  listening: boolean;
  onSetLanExposed: (exposed: boolean) => void;
  onSetTailscaleServe: (enabled: boolean) => void;
  onRefreshTailscale: () => void;
}) {
  const { tailscale } = remote;
  const routed = tailscale.serving || remote.lanExposed;
  return (
    <section className="settings-group" aria-labelledby="phone-routes-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-routes-heading">How your phone gets here</h3>
          <p>Pick a way in. With neither on, only this Mac can open the page.</p>
        </div>
      </div>

      {!listening && <p className="settings-empty">Turn phone access on to choose a way in.</p>}

      {listening && (
        <>
          <Route
            id="tailscale"
            name="Over Tailscale"
            on={tailscale.serving}
            chosen={remote.primary?.kind === "tailscale-https"}
            summary={tailscaleMessage(tailscale)}
            address={addressOf(remote, "tailscale-https")}
            note="Works anywhere, including mobile data. Real certificate, so the phone sees no warning. Needs Tailscale on the phone too."
            action={<button type="button" onClick={onRefreshTailscale}><RefreshCw size={13} aria-hidden="true" /> Check again</button>}
            disabled={tailscale.status !== "ready" || (!tailscale.certs && !tailscale.serving)}
            onToggle={() => onSetTailscaleServe(!tailscale.serving)}
          />

          <Route
            id="lan"
            name="On this Wi-Fi"
            on={remote.lanExposed}
            chosen={remote.primary?.kind === "lan"}
            summary={remote.lanExposed ? "Anything on this network can reach the page." : "Only this Mac can reach the page."}
            address={addressOf(remote, "lan")}
            note="Nothing to install, but the link is plain HTTP. Anyone on the network can read the phone's key and drive this Mac. Fine at home, not on a shared network."
            disabled={false}
            onToggle={() => onSetLanExposed(!remote.lanExposed)}
          />

          {!routed && <p className="settings-empty">No way in is on. A QR code made now points at this Mac itself.</p>}
        </>
      )}

      {tailscale.error && <p className="settings-error" role="alert">{tailscale.error}</p>}
    </section>
  );
}

/** The phones connected right now. */
function SessionSection({ sessions }: { sessions: MobileSessionView[] }) {
  return (
    <section className="settings-group" aria-labelledby="phone-sessions-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-sessions-heading">Connected</h3>
          <p>A connected phone holds this Mac awake, and for five minutes after it leaves. Closing the lid still sleeps the Mac.</p>
        </div>
        <div className="settings-group-action"><span>{sessions.length} connected</span></div>
      </div>

      {sessions.length === 0
        ? <p className="settings-empty">No phone is connected.</p>
        : sessions.map((session) => (
          <div className="setting-row" key={session.id}>
            <span className={`setting-status ${session.connection === "live" ? "granted" : ""}`}>{session.connection === "live" && <Check size={13} />}</span>
            <div>
              <strong>{session.deviceName}</strong>
              <p>{connectionLabel(session.connection)}</p>
            </div>
          </div>
        ))}
    </section>
  );
}

function DeviceSection({ devices, onRevokeDevice }: { devices: PairedDeviceView[]; onRevokeDevice: (deviceId: string) => void }) {
  return (
    <section className="settings-group" aria-labelledby="phone-devices-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-devices-heading">Paired phones</h3>
          <p>Revoking a phone forgets its key and cuts it off at once. While any phone is paired, closing this window hides it rather than quitting.</p>
        </div>
        <div className="settings-group-action"><span>{devices.length} paired</span></div>
      </div>

      {devices.length === 0
        ? <p className="settings-empty">No phone has paired.</p>
        : devices.map((device) => (
          <div className="setting-row" key={device.id}>
            <span className="setting-status blank"><Smartphone size={13} /></span>
            <div>
              <strong>{device.name}</strong>
              <p>{lastSeenLabel(device)}</p>
            </div>
            <div className="setting-row-action">
              <button className="danger" type="button" onClick={() => onRevokeDevice(device.id)}>Revoke</button>
            </div>
          </div>
        ))}
    </section>
  );
}

export type MobileSettingsProps = {
  remote: MobileServerState;
  onSetEnabled: (enabled: boolean) => void;
  onSetLanExposed: (exposed: boolean) => void;
  onCreatePairingCode: () => void;
  onRevokeDevice: (deviceId: string) => void;
  onSetTailscaleServe: (enabled: boolean) => void;
  onRefreshTailscale: () => void;
};

export function MobileSettings({
  remote,
  onSetEnabled,
  onSetLanExposed,
  onCreatePairingCode,
  onRevokeDevice,
  onSetTailscaleServe,
  onRefreshTailscale,
}: MobileSettingsProps) {
  const listening = remote.enabled && remote.status === "listening";

  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Phone</h2>
        <p>Reach your threads from a phone's browser. The phone sends the same commands this window does.</p>
      </div>

      <section className="settings-group" aria-labelledby="phone-availability-heading">
        <div className="settings-group-heading">
          <div><h3 id="phone-availability-heading">Availability</h3></div>
          <span className={listening ? "ready" : ""}>{statusLabel(remote)}</span>
        </div>

        <div className="setting-row">
          <span className={`setting-status ${listening ? "granted" : ""}`}>{listening && <Check size={13} />}</span>
          <div>
            <strong>Phone access</strong>
            <p>Runs a small server that a paired phone talks to. Turning it off drops every phone.</p>
          </div>
          <div className="setting-row-action">
            <button type="button" role="switch" aria-checked={remote.enabled} onClick={() => onSetEnabled(!remote.enabled)}>{remote.enabled ? "Turn off" : "Turn on"}</button>
          </div>
        </div>

        {listening && addressOf(remote, "loopback") && (
          <p className="phone-local">
            Serving on <code>{addressOrigin(addressOf(remote, "loopback")!)}</code>, which only this Mac can open. A phone needs a way in below.
          </p>
        )}

        {remote.error && <p className="settings-error" role="alert">{remote.error}</p>}
      </section>

      <RouteSection
        remote={remote}
        listening={listening}
        onSetLanExposed={onSetLanExposed}
        onSetTailscaleServe={onSetTailscaleServe}
        onRefreshTailscale={onRefreshTailscale}
      />

      <PairingSection pairing={remote.pairing} listening={listening} onCreatePairingCode={onCreatePairingCode} />

      <SessionSection sessions={remote.sessions} />

      <DeviceSection devices={remote.devices} onRevokeDevice={onRevokeDevice} />
    </main>
  );
}
