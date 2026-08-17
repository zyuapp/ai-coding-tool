import { MonitorCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermissions } from "../../contracts/ipc";

type Step = "intro" | "permissions" | "ready";

export function ComputerUseSetupCard({ onDismiss }: { onDismiss: () => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const [step, setStep] = useState<Step>("intro");
  const [permissions, setPermissions] = useState<ComputerUsePermissions>({ accessibility: false, screenRecording: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    const conversation = card?.closest<HTMLElement>(".conversation");
    if (!card || !conversation) return;
    const overflow = card.getBoundingClientRect().bottom - conversation.getBoundingClientRect().bottom;
    if (overflow > 0) conversation.scrollTop += overflow + 12;
  }, [step, permissions]);

  useEffect(() => {
    if (step !== "permissions") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await window.desktop.computerUsePermissions();
        if (cancelled) return;
        setPermissions(next);
        if (next.accessibility && next.screenRecording) setStep("ready");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const interval = window.setInterval(() => void refresh(), 1_000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [step]);

  async function update(request: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = request ? await window.desktop.enableComputerUse() : await window.desktop.computerUsePermissions();
      setPermissions(next);
      setStep(next.accessibility && next.screenRecording ? "ready" : "permissions");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="computer-use-card" aria-live="polite" ref={cardRef}>
      <div className="computer-use-icon"><MonitorCog size={18} aria-hidden="true" /></div>
      <div>
        <strong>{step === "ready" ? "Computer use is ready" : "Enable computer use"}</strong>
        {step === "intro" && <p>Claudex will ask macOS for Accessibility and Screen Recording. It only captures when you ask Claude to use an app.</p>}
        {step === "permissions" && (
          <>
            <p>{!permissions.accessibility
              ? "Turn on Claudex in Accessibility. This checklist updates automatically."
              : "Turn on Claudex in Screen & System Audio Recording. This checklist updates automatically."}</p>
            <ul>
              <li className={permissions.accessibility ? "granted" : ""}>Accessibility <span>{permissions.accessibility ? "Enabled" : "Required"}</span></li>
              <li className={permissions.screenRecording ? "granted" : ""}>Screen &amp; System Audio Recording <span>{permissions.screenRecording ? "Enabled" : "Required"}</span></li>
            </ul>
            <small>The setup check captures one frame and discards it. Claudex does not record system audio.</small>
          </>
        )}
        {step === "ready" && <p>Restart Claudex to activate computer use. The interrupted action will not run automatically.</p>}
        {error && <p className="computer-use-error" role="alert">{error}</p>}
        <div className="computer-use-actions">
          {step !== "ready" && <button className="secondary" type="button" onClick={onDismiss}>Not now</button>}
          {step === "intro" && <button type="button" disabled={busy} onClick={() => void update(true)}>{busy ? "Requesting…" : "Enable computer use"}</button>}
          {step === "permissions" && <button type="button" disabled={busy} onClick={() => void update(true)}>{busy ? "Opening…" : "Open permission settings"}</button>}
          {step === "ready" && <button type="button" onClick={() => window.desktop.restartForComputerUse()}>Restart and continue</button>}
        </div>
      </div>
    </section>
  );
}
