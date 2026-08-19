import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { barShare, formatReset, formatShare, planLabel, type PlanUsage } from "../../domain/plan-usage";

const HIGH_SHARE = 90;

function UsageBar({ share }: { share: number | null }) {
  return (
    <div className="usage-window-bar">
      <span className="usage-window-track" aria-hidden="true">
        <span className={`usage-window-fill ${(share ?? 0) >= HIGH_SHARE ? "high" : ""}`} style={{ width: `${barShare(share)}%` }} />
      </span>
      <span className="usage-window-share">{formatShare(share)}</span>
    </div>
  );
}

export function UsageSettings({ timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: { timeZone?: string }) {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [reading, setReading] = useState(false);

  const read = useCallback(async () => {
    setReading(true);
    try {
      return await window.desktop.planUsage();
    } catch (cause) {
      return { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } as const;
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void read().then((next) => {
      if (!cancelled) setUsage(next);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  const plan = usage?.status === "available" ? planLabel(usage.subscription) : null;
  return (
    <section className="settings-group" aria-labelledby="plan-limits-heading" aria-live="polite">
      <div className="settings-group-heading">
        <div>
          <h3 id="plan-limits-heading">Plan limits</h3>
          <p>How much of each Claude rate-limit window this machine has spent.</p>
        </div>
        <div className="settings-group-action">
          {plan && <span className="usage-plan">{plan}</span>}
          <button type="button" disabled={reading} onClick={() => void read().then(setUsage)}>
            <RotateCw size={13} aria-hidden="true" />
            <span>{reading ? "Reading…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {usage === null && <p className="settings-empty">Reading usage…</p>}

      {usage?.status === "not-applicable" && (
        <p className="settings-empty">This machine signs in with an API key or a third-party provider, so no plan limits apply.</p>
      )}

      {usage?.status === "unavailable" && (
        <p className="settings-error" role="alert">{usage.message}</p>
      )}

      {usage?.status === "available" && (
        <div className="usage-windows">
          {usage.windows.map((window) => {
            const reset = formatReset(window.resetsAt, Date.now(), timeZone);
            return (
              <div className="usage-window" key={window.id}>
                <strong>{window.label}</strong>
                <UsageBar share={window.utilization} />
                {reset && <p>{reset}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
