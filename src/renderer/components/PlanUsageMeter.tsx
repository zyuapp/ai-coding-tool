import { useId } from "react";
import { LuX as X } from "react-icons/lu";
import { barShare, formatReset, NEAR_LIMIT_SHARE, planLabel, tightestWindow, usageWarningKey, windowsFor, type PlanUsage } from "../../domain/plan-usage";
import { modelLabel, type AgentModel } from "../../domain/agent-engine";
import { UsageCard, UsageCardRow } from "./UsageCard";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What the composer for the thread on screen knows of the plan its engine runs on. */
export type ComposerPlanUsage = {
  usage: PlanUsage | undefined;
  /** Warnings about a window running low the user has put away. */
  dismissed: readonly string[];
  /** Set while the thread waits out a limit, which the transcript already says. */
  limitPaused: boolean;
  onDismiss: (warning: string) => void;
};

/** `model` is the one the composer sends to, which picks out the windows only it spends. */
type PlanUsageProps = { engineLabel: string; model: AgentModel; usage: PlanUsage | undefined };

/** The window of the composer's plan closest to running out, with every window it spends on hover. */
export function PlanUsageMeter({ engineLabel, model, usage }: PlanUsageProps) {
  const cardId = useId();
  const windows = windowsFor(usage, modelLabel(model));
  const tightest = tightestWindow(windows);
  if (usage?.status !== "available" || !tightest) return null;
  const share = Math.round(barShare(tightest.utilization));
  const near = share >= NEAR_LIMIT_SHARE;

  return (
    <span className={`plan-usage${near ? " near" : ""}`} tabIndex={0} aria-label={`${share}% of ${engineLabel} plan used`} aria-describedby={cardId}>
      <span className="plan-usage-track" aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
      <span className="plan-usage-share" aria-hidden="true">{share}%</span>
      <UsageCard id={cardId} title={engineLabel} aside={planLabel(usage.subscription)}>
        {windows.map((window) => {
          const windowShare = Math.round(barShare(window.utilization));
          return <UsageCardRow
            key={window.id}
            label={window.label}
            value={window.utilization === null ? "Not reported" : `${windowShare}%`}
            share={windowShare}
            high={windowShare >= NEAR_LIMIT_SHARE}
            detail={formatReset(window.resetsAt, Date.now(), TIME_ZONE, { zone: false })}
          />;
        })}
      </UsageCard>
    </span>
  );
}

/** A line over the composer once a window the next message spends runs low, until the user puts it away. */
export function PlanUsageWarning({ engine, engineLabel, model, usage, dismissed, limitPaused, onDismiss }: PlanUsageProps & ComposerPlanUsage & { engine: string }) {
  const tightest = tightestWindow(windowsFor(usage, modelLabel(model)));
  if (limitPaused || !tightest || tightest.utilization < NEAR_LIMIT_SHARE) return null;
  const warning = usageWarningKey(engine, tightest);
  if (dismissed.includes(warning)) return null;
  const share = Math.round(barShare(tightest.utilization));
  const reset = formatReset(tightest.resetsAt, Date.now(), TIME_ZONE, { zone: false });

  return (
    <div className="plan-usage-warning" role="status">
      <span className="plan-usage-track" aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
      <strong>{share >= 100 ? "Limit reached" : `${share}% used`}</strong>
      <span className="plan-usage-warning-window">{engineLabel} · {tightest.label}</span>
      {reset && <span className="plan-usage-warning-reset">{reset}</span>}
      <button type="button" aria-label="Dismiss" onClick={() => onDismiss(warning)}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
