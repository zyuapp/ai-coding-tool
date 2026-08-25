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

function addressLabel(address: MobileAddress): string {
  switch (address.kind) {
    case "tailscale-https": return "Over Tailscale, with a real certificate.";
    case "lan": return "Anything on this network can reach it.";
    default: return "This Mac only.";
  }
}

function tailscaleMessage(tailscale: TailscaleState): string {
  switch (tailscale.status) {
    case "ready": return tailscale.magicDnsName
      ? `Signed in as ${tailscale.magicDnsName}.`
      : "Signed in. Tailscale has yet to say what this machine is called.";
    case "missing": return "Tailscale is not installed on this Mac. Install it to reach the app from a phone that is not on this network.";
    case "logged-out": return "Tailscale is installed but signed out. Sign in to it, then come back here.";
    default: return "Looking for Tailscale…";
  }
}

/** How long the code on screen has left, counted down to nothing rather than into the past. */
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

/** The pairing URL as a QR, drawn off the main thread and thrown away when the code changes. */
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
  return connection === "resuming" ? "Catching up on what it missed." : "Reconnecting…";
}

function lastSeenLabel(device: PairedDeviceView): string {
  if (device.lastSeenAt === null) return "Has not connected yet.";
  const days = Math.floor((Date.now() - device.lastSeenAt) / 86_400_000);
  if (days === 0) return "Last seen today.";
  return days === 1 ? "Last seen yesterday." : `Last seen ${days} days ago.`;
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
          <p>Scan this with the phone's camera. The code works once and dies after two minutes; the phone keeps a key of its own from then on.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={!listening} onClick={onCreatePairingCode}>{live ? "New code" : "Show a code"}</button>
        </div>
      </div>

      {!listening && <p className="settings-empty">Turn phone access on to pair a phone.</p>}
      {listening && !live && <p className="settings-empty">No code on screen. Ask for one when the phone is in your hand.</p>}
      {listening && live && (
        <div className="phone-pairing">
          {qr
            ? <img className="phone-qr" src={qr} alt={`QR code for ${pairing.url}`} />
            : <div className="phone-qr placeholder" aria-hidden="true" />}
          <div className="phone-pairing-copy">
            <strong>{pairing.code}</strong>
            <p>Expires in {countdownLabel(remaining)}.</p>
            <code>{pairing.url}</code>
          </div>
        </div>
      )}
    </section>
  );
}

function TailscaleSection({ tailscale, listening, onSetTailscaleServe, onRefreshTailscale }: { tailscale: TailscaleState; listening: boolean; onSetTailscaleServe: (enabled: boolean) => void; onRefreshTailscale: () => void }) {
  return (
    <section className="settings-group" aria-labelledby="phone-tailscale-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-tailscale-heading">Tailscale</h3>
          <p>Tailscale Serve puts HTTPS with a real certificate in front of the local server, so a phone anywhere on your tailnet can reach it.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" onClick={onRefreshTailscale}><RefreshCw size={13} aria-hidden="true" /> Check again</button>
        </div>
      </div>

      <div className="setting-row">
        <span className={`setting-status ${tailscale.serving ? "granted" : ""}`}>{tailscale.serving && <Check size={13} />}</span>
        <div>
          <strong>Serve over HTTPS</strong>
          <p>{tailscaleMessage(tailscale)}</p>
        </div>
        <div className="setting-row-action">
          <button type="button" role="switch" aria-checked={tailscale.serving} disabled={tailscale.status !== "ready" || !listening} onClick={() => onSetTailscaleServe(!tailscale.serving)}>
            {tailscale.serving ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>

      {tailscale.error && <p className="settings-error" role="alert">{tailscale.error}</p>}
    </section>
  );
}

/** The phones on the line right now, which is what keeps this Mac awake. */
function SessionSection({ sessions }: { sessions: MobileSessionView[] }) {
  return (
    <section className="settings-group" aria-labelledby="phone-sessions-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-sessions-heading">Connected</h3>
          <p>A phone on the line holds this Mac awake for as long as it is there and five minutes after, so a run it started survives the screen locking. Closing the lid still sleeps the Mac.</p>
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
          <p>Revoking a phone forgets its key and cuts it off at once. While any phone is paired, closing this window puts it away rather than quitting; the Dock icon brings it back.</p>
        </div>
        <div className="settings-group-action"><span>{devices.length} paired</span></div>
      </div>

      {devices.length === 0
        ? <p className="settings-empty">No phone has paired with this Mac.</p>
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
        <p>Reach your threads from a phone's browser. The phone sends the same commands the window does, so nothing it asks for happens anywhere else.</p>
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
            <p>Runs a small server on this Mac that a paired phone talks to. Turning it off drops every phone at once.</p>
          </div>
          <div className="setting-row-action">
            <button type="button" role="switch" aria-checked={remote.enabled} onClick={() => onSetEnabled(!remote.enabled)}>{remote.enabled ? "Turn off" : "Turn on"}</button>
          </div>
        </div>

        {remote.addresses.map((address) => (
          <div className="setting-row" key={`${address.kind}-${address.host}-${address.port}`}>
            <span className="setting-status blank" aria-hidden="true" />
            <div className="phone-address">
              <strong>{addressOrigin(address)}</strong>
              <p>{addressLabel(address)}</p>
            </div>
            <div className="setting-row-action">
              {remote.primary?.kind === address.kind && <em>In the QR code</em>}
            </div>
          </div>
        ))}

        {remote.error && <p className="settings-error" role="alert">{remote.error}</p>}
      </section>

      <PairingSection pairing={remote.pairing} listening={listening} onCreatePairingCode={onCreatePairingCode} />

      <TailscaleSection tailscale={remote.tailscale} listening={listening} onSetTailscaleServe={onSetTailscaleServe} onRefreshTailscale={onRefreshTailscale} />

      <section className="settings-group" aria-labelledby="phone-network-heading">
        <div className="settings-group-heading">
          <div><h3 id="phone-network-heading">Local network</h3></div>
        </div>

        <div className="setting-row">
          <span className={`setting-status ${remote.lanExposed ? "granted" : ""}`}>{remote.lanExposed && <Check size={13} />}</span>
          <div>
            <strong>Listen on this network</strong>
            <p>Less safe. The address is plain HTTP, so anything sharing the network sees the traffic and can try the pairing code. Tailscale is the better door.</p>
          </div>
          <div className="setting-row-action">
            <button type="button" role="switch" aria-checked={remote.lanExposed} onClick={() => onSetLanExposed(!remote.lanExposed)}>{remote.lanExposed ? "Turn off" : "Turn on"}</button>
          </div>
        </div>
      </section>

      <SessionSection sessions={remote.sessions} />

      <DeviceSection devices={remote.devices} onRevokeDevice={onRevokeDevice} />
    </main>
  );
}
