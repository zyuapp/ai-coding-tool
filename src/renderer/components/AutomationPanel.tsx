import { useEffect, useState } from "react";
import { AlarmClock, Bell, BellOff, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import type { AutomationPatch, AutomationView } from "../../domain/automation";

export type AutomationPanelProps = {
  automation: AutomationView | null;
  /** When a run on this thread last found something, which is the only proof a quiet schedule works. */
  lastFoundAt: number | null;
  onUpdate: (patch: AutomationPatch) => void;
  onDelete: () => void;
  onRunNow: () => void;
};

/** Paused and missed both have no next run; only one of them is the user's own doing. */
export function automationStatusLabel(automation: AutomationView, at: number) {
  if (automation.paused) return "Paused";
  if (automation.nextRunAt === null) return "Missed";
  return formatCountdown(automation.nextRunAt, at);
}

const DAY = 86_400_000;

/** What a schedule silenced from the panel surfaces for, until the automation words it for itself. */
const DEFAULT_SURFACE_WHEN = "the run finds something the user has to act on.";

/** Within a day of now the clock is enough; anything further needs the date to mean anything. */
function formatMoment(moment: number, at: number) {
  return Math.abs(moment - at) < DAY
    ? new Date(moment).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : new Date(moment).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatCountdown(nextRunAt: number, at: number) {
  const seconds = Math.max(0, Math.round((nextRunAt - at) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3_600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3_600)}h`;
  return formatMoment(nextRunAt, at);
}

/** What the panel has to answer: is this schedule alive, and has it ever found anything. */
export function automationMeta(automation: AutomationView, lastFoundAt: number | null, at: number) {
  return [
    `${automation.runCount} ${automation.runCount === 1 ? "run" : "runs"}`,
    lastRunLabel(automation, at),
    lastFoundAt ? `found something ${formatMoment(lastFoundAt, at)}` : "nothing found yet",
    ...(automation.overrunCount ? [`${automation.overrunCount} dropped for overrunning`] : []),
  ].join(" · ");
}

/** A tick that never ran still has a status, so the moment shown is the status's rather than the run's. */
export function lastRunLabel(automation: AutomationView, at: number) {
  const when = automation.lastStatusAt ?? automation.lastRunAt;
  if (when === undefined) return "never run";
  return `${automation.lastStatus ?? "ran"} at ${formatMoment(when, at)}`;
}

export function AutomationPanel({ automation, lastFoundAt, onUpdate, onDelete, onRunNow }: AutomationPanelProps) {
  const [schedule, setSchedule] = useState(automation?.schedule ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [now, setNow] = useState(() => Date.now());
  const revision = automation ? `${automation.id}:${automation.updatedAt}` : "";

  useEffect(() => {
    setSchedule(automation?.schedule ?? "");
    setPrompt(automation?.prompt ?? "");
  }, [revision]);

  useEffect(() => {
    if (!automation || automation.nextRunAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [automation?.nextRunAt]);

  if (!automation) {
    return (
      <section className="automation-panel" aria-label="Automation">
        <header className="agents-panel-heading">
          <div><h2>Automation</h2><p>Repeat this task on a schedule</p></div>
        </header>
        <div className="agents-panel-empty">
          <span className="agent-orb"><AlarmClock size={17} /></span>
          <h2>No automation yet</h2>
          <p>Ask Claude to repeat this task — “run this every morning at 8” — and it appears here.</p>
        </div>
      </section>
    );
  }

  const dirty = schedule !== automation.schedule || prompt !== automation.prompt;

  return (
    <section className="automation-panel" aria-label="Automation">
      <header className="agents-panel-heading">
        <div><h2>Automation</h2><p>Repeat this task on a schedule</p></div>
        <span>{automationStatusLabel(automation, now)}</span>
      </header>

      <div className="automation-body">
        <label className="automation-field">
          <span>Schedule</span>
          <input
            value={schedule}
            aria-label="Automation schedule"
            spellCheck={false}
            onInput={(event) => setSchedule(event.currentTarget.value)}
          />
        </label>

        <label className="automation-field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            rows={10}
            aria-label="Automation prompt"
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>

        {automation.surfaceWhen !== undefined && (
          <p className="automation-quiet-sentence">Surfaces when: {automation.surfaceWhen}</p>
        )}

        <button
          type="button"
          className="automation-quiet"
          aria-pressed={automation.surfaceWhen !== undefined}
          onClick={() => onUpdate({ surfaceWhen: automation.surfaceWhen === undefined ? DEFAULT_SURFACE_WHEN : "" })}
        >
          {automation.surfaceWhen === undefined ? <Bell size={13} aria-hidden="true" /> : <BellOff size={13} aria-hidden="true" />}
          <span>Only surface runs that find something</span>
        </button>

        <p className="automation-meta">
          <AlarmClock size={13} aria-hidden="true" />
          <span>{automationMeta(automation, lastFoundAt, now)}</span>
        </p>

        <div className="automation-actions">
          <button type="button" disabled={!dirty} onClick={() => onUpdate({ schedule, prompt })}>Save</button>
          <button type="button" onClick={() => onUpdate({ paused: !automation.paused })} aria-label={automation.paused ? "Resume automation" : "Pause automation"}>
            {automation.paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button type="button" onClick={onRunNow} aria-label="Run automation now"><RotateCw size={14} /></button>
          <button type="button" className="automation-remove" onClick={onDelete} aria-label="Remove automation"><Trash2 size={14} /></button>
        </div>
      </div>
    </section>
  );
}
