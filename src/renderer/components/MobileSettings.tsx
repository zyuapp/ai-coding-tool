import { LuCheck as Check, LuRefreshCw as RefreshCw, LuSmartphone as Smartphone } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { addressOrigin, type MobileAddress, type MobileConnectionState, type MobilePairingOffer, type MobileServerState, type MobileSessionView, type PairedDeviceView, type TailscaleState } from "../../domain/mobile";
import { SettingRow } from "./SettingRow";

function statusLabel(remote: MobileServerState): string {
  if (!remote.enabled) return "Off";
  switch (remote.status) {
    case "listening": return reachable(remote) ? "On" : "Waiting for Tailscale";
    case "starting": return "Starting…";
    case "error": return "Failed to start";
    default: return "Off";
  }
}

function addressOf(remote: MobileServerState, kind: MobileAddress["kind"]): MobileAddress | null {
  return remote.addresses.find((address) => address.kind === kind) ?? null;
}

/** Whether a phone can reach the bridge at all, which is only ever through Tailscale. */
function reachable(remote: MobileServerState): boolean {
  return remote.primary?.kind === "tailscale-https";
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

/** The pairing URL as a QR image, redrawn when the URL changes. The encoder is fetched with the
 * first pairing offer, because pairing a phone is the only thing in the app that draws a QR. */
function useQrCode(url: string | null): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(url, { margin: 1, scale: 6, errorCorrectionLevel: "M" }))
      .then((drawn) => { if (!cancelled) setImage(drawn); })
      .catch(() => { if (!cancelled) setImage(null); });
    return () => { cancelled = true; };
  }, [url]);
  return image;
}

/** One line of the Tailscale checklist: done, still to do, or not yet worth asking about. */
type Step = { id: string; done: boolean; name: string; hint: string | null };

function tailscaleSteps(tailscale: TailscaleState, on: boolean): Step[] {
  const installed = tailscale.status !== "missing" && tailscale.status !== "unknown";
  const unavailable = tailscale.status === "unavailable";
  const signedIn = tailscale.status === "ready";
  const steps: Step[] = [
    {
      id: "installed",
      done: installed,
      name: "Installed on this computer",
      hint: tailscale.status === "unknown" ? "Looking for Tailscale…" : installed ? null : "Install Tailscale, then check again.",
    },
    {
      id: "signed-in",
      done: signedIn,
      name: signedIn && tailscale.magicDnsName ? `Signed in as ${tailscale.magicDnsName}` : "Signed in",
      hint: installed && !signedIn && !unavailable ? "Open Tailscale and sign in." : null,
    },
    {
      id: "https",
      done: signedIn && tailscale.certs,
      name: "HTTPS on",
      hint: signedIn && !tailscale.certs ? "Turn on HTTPS in the Tailscale admin console, under DNS." : null,
    },
    {
      id: "serving",
      done: tailscale.serving,
      name: "Serving this computer",
      hint: !on ? "Turns on with phone access." : tailscale.serving || !signedIn || !tailscale.certs ? null : "Not serving yet. Check again.",
    },
  ];
  return steps;
}

function TailscaleSection({ remote, checking, onRefresh }: { remote: MobileServerState; checking: boolean; onRefresh: () => void }) {
  const on = remote.enabled && remote.status === "listening";
  const address = addressOf(remote, "tailscale-https");
  const steps = tailscaleSteps(remote.tailscale, on);
  /** The first thing still to do is the one the user acts on, so only it is drawn as needed. */
  const needed = steps.find((step) => !step.done && step.hint && !(step.id === "serving" && !on))?.id ?? null;
  return (
    <section className="settings-group" aria-labelledby="phone-tailscale-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-tailscale-heading">Tailscale</h3>
          <p>The phone reaches this computer over your tailnet, so both need Tailscale signed into the same account.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={checking} onClick={onRefresh}><RefreshCw size={13} aria-hidden="true" className={checking ? "spinning" : ""} />{checking ? "Checking…" : "Check again"}</button>
        </div>
      </div>
      {steps.map((step) => (
        <div className={`phone-check${step.done ? "" : " waiting"}${step.id === needed ? " needed" : ""}`} key={step.id} data-step={step.id}>
          <span className={`setting-status ${step.done ? "granted" : ""}`}>{step.done && <Check size={13} />}</span>
          <div>
            <strong>{step.name}</strong>
            {step.done && step.id === "serving" && address && <p><code>{addressOrigin(address)}</code></p>}
            {!step.done && step.hint && <p>{step.hint}</p>}
          </div>
        </div>
      ))}
      {remote.tailscale.error && <p className="settings-error" role="alert">{remote.tailscale.error}</p>}
    </section>
  );
}

/**
 * The QR and the code beside it. A code is asked for the moment the bridge can be reached and none
 * is on screen, and again when the one on screen runs out while the page is open, so the user never
 * has to press anything before scanning.
 */
function PairingSection({ pairing, ready, onCreatePairingCode }: { pairing: MobilePairingOffer | null; ready: boolean; onCreatePairingCode: () => void }) {
  const remaining = useCountdown(pairing?.expiresAt ?? null);
  const live = pairing !== null && remaining > 0;
  const qr = useQrCode(pairing?.url ?? null);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || live) return;
    /** One request per code that has run out, so a bridge that will not mint is not asked in a loop. */
    const key = pairing?.code ?? "none";
    if (asked.current === key) return;
    asked.current = key;
    onCreatePairingCode();
  }, [ready, live, pairing?.code, onCreatePairingCode]);

  return (
    <section className="settings-group" aria-labelledby="phone-pairing-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-pairing-heading">Pair a phone</h3>
          <p>Scan the code with the phone's camera. Each code works once and lasts two minutes.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={!ready} onClick={onCreatePairingCode}>New code</button>
        </div>
      </div>

      {!ready && <p className="settings-empty">Turn phone access on and finish the Tailscale steps to pair a phone.</p>}
      {ready && !pairing && <p className="settings-empty">Making a code…</p>}
      {ready && pairing && (
        <div className="phone-pairing">
          {qr
            ? <img className={`phone-qr${live ? "" : " expired"}`} src={qr} alt={`QR code for ${pairing.url}`} />
            : <div className="phone-qr placeholder" aria-hidden="true" />}
          <div className="phone-pairing-copy">
            <strong>{pairing.code}</strong>
            {live
              ? <p>Expires in {countdownLabel(remaining)}.</p>
              : <p className="phone-pairing-expired">This code has expired. Making a new one…</p>}
            <code>{pairing.url}</code>
          </div>
        </div>
      )}
    </section>
  );
}

/** What a phone is doing right now, from the best of the sessions it holds. */
function deviceConnection(device: PairedDeviceView, sessions: MobileSessionView[]): MobileConnectionState | null {
  const rank: MobileConnectionState[] = ["live", "resuming", "connecting", "offline"];
  const held = sessions.filter((session) => session.deviceId === device.id);
  for (const state of rank) if (held.some((session) => session.connection === state)) return state;
  return null;
}

function deviceLabel(device: PairedDeviceView, connection: MobileConnectionState | null): string {
  if (connection === "live") return "Connected";
  if (connection === "resuming") return "Catching up…";
  if (connection === "connecting") return "Connecting…";
  if (connection === "offline") return "Reconnecting…";
  if (device.lastSeenAt === null) return "Never connected";
  const days = Math.floor((Date.now() - device.lastSeenAt) / 86_400_000);
  if (days === 0) return "Seen today";
  return days === 1 ? "Seen yesterday" : `Seen ${days} days ago`;
}

function DeviceSection({ devices, sessions, onRevokeDevice }: { devices: PairedDeviceView[]; sessions: MobileSessionView[]; onRevokeDevice: (deviceId: string) => void }) {
  const connected = devices.filter((device) => deviceConnection(device, sessions) === "live").length;
  return (
    <section className="settings-group" aria-labelledby="phone-devices-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="phone-devices-heading">Phones</h3>
          <p>A connected phone keeps this computer awake. Closing this window stops phone access. Removing a phone cuts it off at once.</p>
        </div>
        <div className="settings-group-action"><span>{devices.length === 0 ? "None paired" : `${connected} of ${devices.length} connected`}</span></div>
      </div>

      {devices.length === 0
        ? <p className="settings-empty">No phone has paired yet.</p>
        : devices.map((device) => {
          const connection = deviceConnection(device, sessions);
          return (
            <div className="setting-row" key={device.id} data-device={device.id}>
              <span className={`setting-status ${connection === "live" ? "granted" : "blank"}`}>{connection === "live" ? <Check size={13} /> : <Smartphone size={13} />}</span>
              <div>
                <strong>{device.name}</strong>
                <p className={`phone-device-state${connection === "live" ? " live" : ""}`}>{deviceLabel(device, connection)}</p>
              </div>
              <div className="setting-row-action">
                <button className="danger" type="button" onClick={() => onRevokeDevice(device.id)}>Remove</button>
              </div>
            </div>
          );
        })}
    </section>
  );
}

export type MobileSettingsProps = {
  remote: MobileServerState;
  remoteChecking: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onCreatePairingCode: () => void;
  onRevokeDevice: (deviceId: string) => void;
  onRefreshTailscale: () => void;
};

export function MobileSettings({ remote, remoteChecking, onSetEnabled, onCreatePairingCode, onRevokeDevice, onRefreshTailscale }: MobileSettingsProps) {
  const listening = remote.enabled && remote.status === "listening";
  const ready = listening && reachable(remote);

  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Phone</h2>
        <p>Read and drive your threads from a phone's browser, anywhere your tailnet reaches.</p>
      </div>

      <section className="settings-group" aria-labelledby="phone-availability-heading">
        <div className="settings-group-heading">
          <div><h3 id="phone-availability-heading">Access</h3></div>
          <span className={ready ? "ready" : ""}>{statusLabel(remote)}</span>
        </div>

        <SettingRow id="phone.availability" status={listening} description="Serves the phone page and puts Tailscale in front of it. Turning it off drops every phone.">
          <button type="button" role="switch" aria-checked={remote.enabled} aria-label="Phone access" onClick={() => onSetEnabled(!remote.enabled)}>{remote.enabled ? "Turn off" : "Turn on"}</button>
        </SettingRow>

        {remote.error && <p className="settings-error" role="alert">{remote.error}</p>}
      </section>

      <TailscaleSection remote={remote} checking={remoteChecking} onRefresh={onRefreshTailscale} />

      <PairingSection pairing={remote.pairing} ready={ready} onCreatePairingCode={onCreatePairingCode} />

      <DeviceSection devices={remote.devices} sessions={remote.sessions} onRevokeDevice={onRevokeDevice} />
    </main>
  );
}
