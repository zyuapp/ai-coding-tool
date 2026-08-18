import { useEffect, useState } from "react";
import { AlarmClock, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import type { AutomationPatch, AutomationView } from "../../domain/automation";

export type AutomationPanelProps = {
  automation: AutomationView | null;
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

export function formatCountdown(nextRunAt: number, at: number) {
  const seconds = Math.max(0, Math.round((nextRunAt - at) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3_600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3_600)}h`;
  return new Date(nextRunAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function lastRunLabel(automation: AutomationView) {
  if (!automation.lastRunAt) return "never run";
  const when = new Date(automation.lastRunAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${automation.lastStatus ?? "ran"} at ${when}`;
}

export function AutomationPanel({ automation, onUpdate, onDelete, onRunNow }: AutomationPanelProps) {
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
      <section className="automation-section" aria-label="Automation">
        <div className="subagent-heading"><span>Automation</span></div>
        <p className="session-empty">Ask Claude to repeat this task — “run this every morning at 8” — and it appears here.</p>
      </section>
    );
  }

  const dirty = schedule !== automation.schedule || prompt !== automation.prompt;

  return (
    <section className="automation-section" aria-label="Automation">
      <div className="subagent-heading">
        <span>Automation</span>
        <span>{automationStatusLabel(automation, now)}</span>
      </div>

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
          rows={3}
          aria-label="Automation prompt"
          onInput={(event) => setPrompt(event.currentTarget.value)}
        />
      </label>

      <p className="automation-meta">
        <AlarmClock size={13} aria-hidden="true" />
        <span>{automation.runCount} {automation.runCount === 1 ? "run" : "runs"} · {lastRunLabel(automation)}</span>
      </p>

      <div className="automation-actions">
        <button type="button" disabled={!dirty} onClick={() => onUpdate({ schedule, prompt })}>Save</button>
        <button type="button" onClick={() => onUpdate({ paused: !automation.paused })} aria-label={automation.paused ? "Resume automation" : "Pause automation"}>
          {automation.paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button type="button" onClick={onRunNow} aria-label="Run automation now"><RotateCw size={14} /></button>
        <button type="button" className="automation-remove" onClick={onDelete} aria-label="Remove automation"><Trash2 size={14} /></button>
      </div>
    </section>
  );
}
