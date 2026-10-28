import { LuMonitor as Monitor, LuRefreshCw as RefreshCw } from "react-icons/lu";
import { SettingGroup } from "./SettingRow";
import { settingControl } from "../../domain/settings-catalog";
import { useEffect, type ReactNode } from "react";
import type { ComputerUsage, PlanUsageState } from "../../application/plan-limits";
import { AGENT_ENGINES, engineLabel, type AgentEngine } from "../../domain/agent-engine";
import { barShare, formatReset, formatShare, planLabel, type PlanUsage } from "../../domain/plan-usage";
import { SpinningIcon } from "./SpinningIcon";

const HIGH_SHARE = 90;

function UsageBar({ label, share }: { label: string; share: number | null }) {
  return (
    <div className="usage-window-bar">
      <span className="usage-window-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={barShare(share)} aria-valuetext={formatShare(share)}>
        <span className={`usage-window-fill ${(share ?? 0) >= HIGH_SHARE ? "high" : ""}`} style={{ width: `${barShare(share)}%` }} />
      </span>
      <span className="usage-window-share" aria-hidden="true">{formatShare(share)}</span>
    </div>
  );
}

export type UsageSettingsProps = {
  usage: PlanUsageState;
  /** What this computer calls itself, which heads its own limits once other computers are listed. */
  name?: string;
  /** Each paired computer's own limits. With none, the page is this computer's alone. */
  computers?: readonly ComputerUsage[];
  onRefresh: () => void;
  timeZone?: string;
};

export function UsageSettings({ usage, name = "", computers = [], onRefresh, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: UsageSettingsProps) {
  useEffect(() => { onRefresh(); }, []);
  /** Only this computer's own read holds the button: a slow computer elsewhere says so in its own section. */
  const reading = usage.reading.length > 0;

  return (
    <SettingGroup setting="usage.plan-limits" aria-labelledby="plan-limits-heading" aria-live="polite">
      <div className="settings-group-heading">
        <div>
          <h3 id="plan-limits-heading">{settingControl("usage.plan-limits").label}</h3>
          <p>Usage and reset times reported by each provider.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={reading} aria-busy={reading || undefined} onClick={onRefresh}>
            <SpinningIcon icon={RefreshCw} spinning={reading} size={14} aria-hidden="true" />
            <span>{reading ? "Reading…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {computers.length === 0
        ? <Providers usage={usage} scope="this" asked timeZone={timeZone} />
        : (
          <div className="usage-computers">
            <ComputerSection id="this" name={name ? `This computer · ${name}` : "This computer"}>
              <Providers usage={usage} scope="this" asked timeZone={timeZone} />
            </ComputerSection>
            {computers.map((computer) => (
              <ComputerSection key={computer.id} id={computer.id} name={computer.name}>
                <PairedUsage computer={computer} timeZone={timeZone} />
              </ComputerSection>
            ))}
          </div>
        )}
    </SettingGroup>
  );
}

function ComputerSection({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const heading = `usage-computer-${id}-heading`;
  return (
    <section className="usage-computer" aria-labelledby={heading} data-usage-computer={id}>
      <h4 id={heading} className="usage-computer-heading"><Monitor size={14} aria-hidden="true" />{name}</h4>
      {children}
    </section>
  );
}

/** A paired computer's limits, or why there are none to draw. */
function PairedUsage({ computer, timeZone }: { computer: ComputerUsage; timeZone: string }) {
  if (computer.status !== "connected") return <p className="settings-empty">{computer.status === "connecting" ? "Reconnecting…" : "Offline"}</p>;
  if (!computer.supported) return <p className="settings-empty">Update AI Coding Tool on that computer to see its limits.</p>;
  if (!computer.usage) return <p className="settings-empty">Reading usage…</p>;
  return <Providers usage={computer.usage} scope={computer.id} timeZone={timeZone} />;
}

/** `asked` marks this computer's own limits, which opening the page always reads. */
function Providers({ usage: { reports, reading }, scope, asked = false, timeZone }: { usage: PlanUsageState; scope: string; asked?: boolean; timeZone: string }) {
  return (
    <div className="usage-providers">
      {AGENT_ENGINES.map((engine) => <ProviderUsage key={engine} engine={engine} usage={reports[engine]} reading={asked || reading.includes(engine)} scope={scope} timeZone={timeZone} />)}
    </div>
  );
}

function ProviderUsage({ engine, usage, reading, scope, timeZone }: { engine: AgentEngine; usage: PlanUsage | undefined; reading: boolean; scope: string; timeZone: string }) {
  const heading = `usage-${scope}-${engine}-heading`;
  const plan = usage?.status === "available" ? planLabel(usage.subscription) : null;
  return (
    <section className="usage-provider" aria-labelledby={heading}>
      <div className="usage-provider-heading">
        <h4 id={heading}>{engineLabel(engine)}</h4>
        {plan && <span className="usage-plan">{plan}</span>}
      </div>

      {usage === undefined && <p className="settings-empty">{reading ? "Reading usage…" : "Not read yet."}</p>}
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
            <UsageBar label={window.label} share={window.utilization} />
            {reset && <p>{reset}</p>}
          </div>
        );
      })}
    </div>
  );
}
