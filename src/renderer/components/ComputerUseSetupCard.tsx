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
        {step === "intro" && <p>Allow Claudex to see and control applications when you ask Claude to use their interface.</p>}
        {step === "permissions" && (
          <>
            <p>{permissions.accessibility
              ? "Turn on Claudex in Screen & System Audio Recording. If it isn't listed, click + and choose Claudex from Applications."
              : "Allow Claudex in Accessibility first, then continue."}</p>
            <ul>
              <li className={permissions.accessibility ? "granted" : ""}>Accessibility <span>{permissions.accessibility ? "Enabled" : "Required"}</span></li>
              <li className={permissions.screenRecording ? "granted" : ""}>Screen &amp; System Audio Recording <span>{permissions.screenRecording ? "Enabled" : "Required"}</span></li>
            </ul>
            <small>Claudex captures app windows for visual understanding; it does not record system audio.</small>
          </>
        )}
        {step === "ready" && <p>Restart Claudex to make computer-use tools available. The interrupted action will not run automatically.</p>}
        {error && <p className="computer-use-error" role="alert">{error}</p>}
        <div className="computer-use-actions">
          {step !== "ready" && <button className="secondary" type="button" onClick={onDismiss}>Not now</button>}
          {step === "intro" && <button type="button" disabled={busy} onClick={() => void update(true)}>{busy ? "Opening…" : "Enable computer use"}</button>}
          {step === "permissions" && <button type="button" disabled={busy} onClick={() => void update(true)}>{busy ? "Opening…" : "Continue"}</button>}
          {step === "ready" && <button type="button" onClick={() => window.desktop.restartForComputerUse()}>Restart Claudex</button>}
        </div>
      </div>
    </section>
  );
}
