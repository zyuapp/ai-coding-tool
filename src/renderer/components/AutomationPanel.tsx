import { CommandButton, useCommandControls } from "./CommandControl";
import { ConfirmAction } from "./SettingRow";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";
import { useEffect, useState } from "react";
import { LuAlarmClock as AlarmClock, LuCheck as Check, LuPause as Pause, LuPlay as Play, LuTrash2 as Trash2 } from "react-icons/lu";
import { isOneShotSchedule, type AutomationPatch, type AutomationView } from "../../domain/automation";

export type AutomationPanelProps = {
  automation: AutomationView | null;
  /** What the engine running this thread is called. */
  engineLabel: string;
  /** When a run on this thread last found something, which is the only proof a quiet schedule works. */
  lastFoundAt: number | null;
  lastChecked: { at: number; note: string } | null;
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
export function automationFacts(automation: AutomationView, lastFoundAt: number | null, lastChecked: { at: number; note: string } | null, at: number): Array<[string, string]> {
  return [
    ["Runs", String(automation.runCount)],
    ["Last run", lastRunLabel(automation, at)],
    ["Last found", lastFoundAt ? formatMoment(lastFoundAt, at) : "Nothing yet"],
    /** A schedule that only ever settles in silence has nothing else to prove it is still looking. */
    ...(lastChecked ? [["Last checked", `${lastChecked.note} ${formatMoment(lastChecked.at, at)}`] as [string, string]] : []),
    ...(automation.overrunCount ? [["Dropped", `${automation.overrunCount} for overrunning`] as [string, string]] : []),
  ];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A schedule read back in words, or why it cannot be read; null for a valid cron too unusual to say simply. */
export function describeSchedule(schedule: string): { text: string; error?: true } | null {
  const trimmed = schedule.trim();
  if (!trimmed) return { text: "Needs a schedule", error: true };
  if (isOneShotSchedule(trimmed)) return { text: `Once, ${new Date(trimmed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return { text: "Use cron, like 0 8 * * *, or a date, like 2026-11-01T09:00", error: true };
  const [minute, hour, day, month, weekday] = fields;
  const every = minute.match(/^\*\/(\d+)$/);
  if (every && hour === "*" && day === "*" && month === "*" && weekday === "*") return { text: `Every ${every[1]} minutes` };
  if (!/^\d+$/.test(minute) || day !== "*" || month !== "*") return null;
  if (hour === "*" && weekday === "*") return { text: `Every hour at :${minute.padStart(2, "0")}` };
  if (!/^\d+$/.test(hour)) return null;
  const time = new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (weekday === "*") return { text: `Every day at ${time}` };
  if (weekday === "1-5") return { text: `Weekdays at ${time}` };
  if (/^[0-6]$/.test(weekday)) return { text: `Every ${WEEKDAYS[Number(weekday)]} at ${time}` };
  return null;
}

/** A tick that never ran still has a status, so the moment shown is the status's rather than the run's. */
export function lastRunLabel(automation: AutomationView, at: number) {
  const when = automation.lastStatusAt ?? automation.lastRunAt;
  if (when === undefined) return "never run";
  return `${automation.lastStatus ?? "ran"} at ${formatMoment(when, at)}`;
}

export function AutomationPanel({ automation, engineLabel, lastFoundAt, lastChecked, onUpdate, onDelete, onRunNow }: AutomationPanelProps) {
  const [schedule, setSchedule] = useState(automation?.schedule ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [surfaceWhen, setSurfaceWhen] = useState(automation?.surfaceWhen ?? "");
  const [endsWhen, setEndsWhen] = useState(automation?.endsWhen ?? "");
  const [now, setNow] = useState(() => Date.now());
  const [saved, setSaved] = useState(false);
  const canDelete = useCommandControls().available({ type: "automation.delete" });
  const revision = automation ? `${automation.id}:${automation.updatedAt}` : "";

  useEffect(() => {
    setSchedule(automation?.schedule ?? "");
    setPrompt(automation?.prompt ?? "");
    setSurfaceWhen(automation?.surfaceWhen ?? "");
    setEndsWhen(automation?.endsWhen ?? "");
  }, [revision]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [saved]);

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
          <span className="agent-orb"><AlarmClock size={18} /></span>
          <h2>No automation yet</h2>
          <p>Ask {engineLabel} to repeat this task, like “run this every morning at 8”. It appears here.</p>
        </div>
      </section>
    );
  }

  /** A one-time run always surfaces, so it has no quiet sentence to say or keep. */
  const oneShot = isOneShotSchedule(schedule);
  const surfaceChanged = !oneShot && surfaceWhen !== (automation.surfaceWhen ?? "");
  const endChanged = endsWhen !== (automation.endsWhen ?? "");
  const dirty = schedule !== automation.schedule || prompt !== automation.prompt || surfaceChanged || endChanged;
  const readout = describeSchedule(schedule);
  const patch = { schedule, prompt, ...(surfaceChanged ? { surfaceWhen } : {}), ...(endChanged ? { endsWhen } : {}) };

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
            aria-invalid={readout?.error}
            aria-describedby={readout ? "automation-schedule-readout" : undefined}
            placeholder="0 8 * * *"
            spellCheck={false}
            onInput={(event) => setSchedule(event.currentTarget.value)}
          />
          {readout && <small id="automation-schedule-readout" className={readout.error ? "error" : undefined}>{readout.text}</small>}
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

        {oneShot ? null : (
          <label className="automation-field">
            <span>Surfaces when</span>
            <input
              value={surfaceWhen}
              aria-label="What a run of this automation surfaces for"
              placeholder="Every run surfaces"
              onInput={(event) => setSurfaceWhen(event.currentTarget.value)}
            />
          </label>
        )}

        <label className="automation-field">
          <span>Ends when</span>
          <input
            value={endsWhen}
            aria-label="What finishes this automation"
            placeholder="Repeats until removed"
            onInput={(event) => setEndsWhen(event.currentTarget.value)}
          />
        </label>

        <dl className="automation-meta">
          {automationFacts(automation, lastFoundAt, lastChecked, now).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>

        <div className="automation-actions">
          <CommandButton command={{ type: "automation.update", patch }} type="button" className="primary" disabled={!dirty || readout?.error} onClick={() => { onUpdate(patch); setSaved(true); }}>{saved && !dirty ? <><Check size={14} aria-hidden="true" />Saved</> : "Save"}</CommandButton>
          <CommandButton command={{ type: "automation.run-now" }} type="button" onClick={onRunNow}>Run now</CommandButton>
          <CommandButton command={{ type: "automation.update", patch: { paused: !automation.paused } }} type="button" onClick={() => onUpdate({ paused: !automation.paused })} aria-label={automation.paused ? "Resume automation" : "Pause automation"} data-tip={automation.paused ? "Resume" : "Pause"}>
            {automation.paused ? <Play size={14} /> : <Pause size={14} />}
          </CommandButton>
          <ConfirmAction className="automation-remove" aria-label="Remove automation" data-tip={canDelete ? "Remove" : REMOTE_UNSUPPORTED} disabled={!canDelete} confirm="Remove" onConfirm={onDelete}><Trash2 size={14} /></ConfirmAction>
        </div>
      </div>
    </section>
  );
}
