import { LuRotateCw as RotateCw } from "react-icons/lu";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_ENGINES, engineLabel, type AgentEngine } from "../../domain/agent-engine";
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
  const [reports, setReports] = useState<Partial<Record<AgentEngine, PlanUsage>>>({});
  const [reading, setReading] = useState<AgentEngine[]>([]);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const current = ++generation.current;
    setReading([...AGENT_ENGINES]);
    for (const engine of AGENT_ENGINES) {
      void window.desktop.planUsage(engine)
        .catch((cause): PlanUsage => ({ status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) }))
        .then((usage) => {
          if (generation.current !== current) return;
          setReports((seen) => ({ ...seen, [engine]: usage }));
          setReading((engines) => engines.filter((item) => item !== engine));
        });
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  return (
    <section className="settings-group" aria-labelledby="plan-limits-heading" aria-live="polite">
      <div className="settings-group-heading">
        <div>
          <h3 id="plan-limits-heading">Plan limits</h3>
          <p>Usage and reset times reported by each provider.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={reading.length > 0} onClick={refresh}>
            <RotateCw size={13} aria-hidden="true" />
            <span>{reading.length > 0 ? "Reading…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      <div className="usage-providers">
        {AGENT_ENGINES.map((engine) => <ProviderUsage key={engine} engine={engine} usage={reports[engine]} timeZone={timeZone} />)}
      </div>
    </section>
  );
}

function ProviderUsage({ engine, usage, timeZone }: { engine: AgentEngine; usage: PlanUsage | undefined; timeZone: string }) {
  const heading = `usage-${engine}-heading`;
  const plan = usage?.status === "available" ? planLabel(usage.subscription) : null;
  return (
    <section className="usage-provider" aria-labelledby={heading}>
      <div className="usage-provider-heading">
        <h4 id={heading}>{engineLabel(engine)}</h4>
        {plan && <span className="usage-plan">{plan}</span>}
      </div>

      {usage === undefined && <p className="settings-empty">Reading usage…</p>}
      {usage?.status === "not-applicable" && <p className="settings-empty">No plan limits apply to this sign-in.</p>}
      {usage?.status === "unavailable" && <p className="settings-error" role="alert">{usage.message}</p>}
      {usage?.status === "available" && <UsageWindows usage={usage} timeZone={timeZone} />}
    </section>
  );
}

function UsageWindows({ usage, timeZone }: { usage: Extract<PlanUsage, { status: "available" }>; timeZone: string }) {
  return (
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
  );
}
