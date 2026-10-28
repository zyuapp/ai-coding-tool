import { useId } from "react";
import { LuX as X } from "react-icons/lu";
import { barShare, formatReset, NEAR_LIMIT_SHARE, planLabel, sessionAndWeek, tightestWindow, usageWarningKey, windowsFor, windowSpan, type PlanUsage, type UsageWindow } from "../../domain/plan-usage";
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
  /** Opens the Usage settings page. A surface without settings of its own leaves it out. */
  onOpen?: () => void;
};

/** `model` is the one the composer sends to, which picks out the windows only it spends. */
type PlanUsageProps = { engineLabel: string; model: AgentModel; usage: PlanUsage | undefined };

function MeterPart({ window }: { window: UsageWindow & { utilization: number } }) {
  const share = Math.round(barShare(window.utilization));
  const span = windowSpan(window);
  return (
    <span className={`plan-usage-part${share >= NEAR_LIMIT_SHARE ? " near" : ""}`}>
      {span && <span className="plan-usage-span">{span}</span>}
      <span className="plan-usage-share">{share}%</span>
    </span>
  );
}

/**
 * The composer's plan at a glance: the session and the fullest week the model spends, or the
 * fullest window alone for a plan that names neither. Hover lists every window it spends.
 */
export function PlanUsageMeter({ engineLabel, model, usage, onOpen }: PlanUsageProps & { onOpen?: () => void }) {
  const cardId = useId();
  const windows = windowsFor(usage, modelLabel(model));
  const { session, week } = sessionAndWeek(windows);
  const tightest = tightestWindow(windows);
  const rows = session || week ? [session, week].filter((row) => row !== null) : tightest ? [tightest] : [];
  if (usage?.status !== "available" || !rows.length) return null;
  const label = rows.map((row) => `${row.label} ${Math.round(barShare(row.utilization))}% used`).join(", ");

  const Meter = onOpen ? "button" : "span";

  return (
    <Meter className="plan-usage" {...(onOpen ? { type: "button" as const, onClick: onOpen } : { tabIndex: 0 })} aria-label={`${engineLabel} plan: ${label}`} aria-describedby={cardId}>
      <span className="plan-usage-parts" aria-hidden="true">{rows.map((row) => <MeterPart key={row.id} window={row} />)}</span>
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
    </Meter>
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
      <button type="button" aria-label="Hide usage warning until reset" data-tip="Hide until reset" onClick={() => onDismiss(warning)}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
