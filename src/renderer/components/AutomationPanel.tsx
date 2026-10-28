import { Cron } from "croner";
import { CommandButton, useCommandControls } from "./CommandControl";
import { ConfirmAction } from "./SettingRow";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";
import { useEffect, useId, useState } from "react";
import { MAC } from "../platform";
import { shortcutTip } from "./TooltipLayer";
import { LuAlarmClock as AlarmClock, LuCheck as Check, LuPause as Pause, LuPlay as Play, LuPlus as Plus, LuTrash2 as Trash2, LuTriangleAlert as AlertTriangle } from "react-icons/lu";
import { isOneShotSchedule, scheduleFieldCount, type AutomationPatch, type AutomationView } from "../../domain/automation";

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

/** The cron each nickname the scheduler accepts stands for. */
const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};

/** Schedules most automations want, filled into the field as cron. */
export const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily", cron: "0 9 * * *" },
  { label: "Weekdays", cron: "0 9 * * 1-5" },
  { label: "Weekly", cron: "0 9 * * 1" },
];

const CRON_HINT = "Use cron, like 0 8 * * *, or a date, like 2026-11-01T09:00";

/** Why the scheduler would turn this schedule down, or null when it takes it. */
function scheduleProblem(schedule: string): string | null {
  if (!isOneShotSchedule(schedule) && scheduleFieldCount(schedule) > 5) return "Runs at most once a minute, so use five fields";
  let cron: Cron;
  try {
    cron = new Cron(schedule, { paused: true });
  } catch {
    return CRON_HINT;
  }
  try {
    return cron.nextRun() ? null : "Never runs again";
  } finally {
    cron.stop();
  }
}

/** A schedule read back in words, or why it cannot be saved; null for a valid cron too unusual to say simply. */
export function describeSchedule(schedule: string): { text: string; error?: true } | null {
  const trimmed = schedule.trim();
  if (!trimmed) return { text: "Needs a schedule", error: true };
  const problem = scheduleProblem(trimmed);
  if (problem) return { text: problem, error: true };
  if (isOneShotSchedule(trimmed)) return { text: `Once, ${new Date(trimmed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` };
  const fields = (NICKNAMES[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (fields.length !== 5) return null;
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

/** Missed is the one status that needs the user, so it alone stands out, and runs the task when pressed. */
function AutomationHeading({ status, started = false, onRunNow }: { status?: string; started?: boolean; onRunNow?: () => void }) {
  return (
    <header className="agents-panel-heading">
      <div><h2>Automation</h2><p>Repeat this task on a schedule</p></div>
      {status === "Missed" && onRunNow ? (
        <CommandButton command={{ type: "automation.run-now" }} type="button" className="automation-missed" data-state="missed" onClick={onRunNow}>
          {started ? <><Check size={12} aria-hidden="true" />Started</> : <><AlertTriangle size={12} aria-hidden="true" />Missed<span>Run now</span></>}
        </CommandButton>
      ) : status && (
        <span data-state={status === "Paused" ? "paused" : undefined}>{status}</span>
      )}
    </header>
  );
}

function SchedulePresets({ schedule, onPick }: { schedule: string; onPick: (cron: string) => void }) {
  return (
    <div className="automation-presets" role="group" aria-label="Common schedules">
      {SCHEDULE_PRESETS.map(({ label, cron }) => {
        const picked = schedule.trim() === cron;
        return (
          <button key={cron} type="button" aria-pressed={picked} onClick={() => onPick(cron)}>
            {picked && <Check size={12} aria-hidden="true" />}{label}
          </button>
        );
      })}
    </div>
  );
}

function AutomationEmpty({ engineLabel, onCreate }: { engineLabel: string; onCreate: () => void }) {
  return (
    <section className="automation-panel" aria-label="Automation">
      <AutomationHeading />
      <div className="agents-panel-empty">
        <span className="agent-orb"><AlarmClock size={18} /></span>
        <h2>No automation yet</h2>
        <p>Ask {engineLabel} to repeat this task, like “run this every morning at 8”. It appears here.</p>
        <CommandButton command={{ type: "automation.save", draft: { prompt: "", schedule: "" } }} type="button" onClick={onCreate}>
          <Plus size={14} aria-hidden="true" />New schedule
        </CommandButton>
      </div>
    </section>
  );
}

export function AutomationPanel({ automation, engineLabel, lastFoundAt, lastChecked, onUpdate, onDelete, onRunNow }: AutomationPanelProps) {
  const [schedule, setSchedule] = useState(automation?.schedule ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [surfaceWhen, setSurfaceWhen] = useState(automation?.surfaceWhen ?? "");
  const [endsWhen, setEndsWhen] = useState(automation?.endsWhen ?? "");
  const [now, setNow] = useState(() => Date.now());
  /** What the last press confirmed, shown on its button for a moment. */
  const [done, setDone] = useState<"saved" | "started" | null>(null);
  /** A new schedule being written before any exists. */
  const [creating, setCreating] = useState(false);
  const controls = useCommandControls();
  const scheduleId = useId();
  const canDelete = controls.available({ type: "automation.delete" });
  const revision = automation ? `${automation.id}:${automation.updatedAt}` : "";

  useEffect(() => {
    setSchedule(automation?.schedule ?? "");
    setPrompt(automation?.prompt ?? "");
    setSurfaceWhen(automation?.surfaceWhen ?? "");
    setEndsWhen(automation?.endsWhen ?? "");
    if (automation) setCreating(false);
  }, [revision]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    if (!automation || automation.nextRunAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [automation?.nextRunAt]);

  if (!automation && !creating) return <AutomationEmpty engineLabel={engineLabel} onCreate={() => setCreating(true)} />;

  /** A one-time run always surfaces, so it has no quiet sentence to say or keep. */
  const oneShot = isOneShotSchedule(schedule);
  const surfaceChanged = !oneShot && surfaceWhen !== (automation?.surfaceWhen ?? "");
  const endChanged = endsWhen !== (automation?.endsWhen ?? "");
  const dirty = !automation || schedule !== automation.schedule || prompt !== automation.prompt || surfaceChanged || endChanged;
  const readout = describeSchedule(schedule);
  const patch = { schedule, prompt, ...(surfaceChanged ? { surfaceWhen } : {}), ...(endChanged ? { endsWhen } : {}) };
  const draft = {
    schedule: schedule.trim(),
    prompt: prompt.trim(),
    ...(!oneShot && surfaceWhen.trim() ? { surfaceWhen: surfaceWhen.trim() } : {}),
    ...(endsWhen.trim() ? { endsWhen: endsWhen.trim() } : {}),
  };
  const save = () => {
    onUpdate(patch);
    setDone("saved");
  };
  const runNow = () => {
    onRunNow();
    setDone("started");
  };
  const canSave = automation ? dirty && !readout?.error : Boolean(draft.prompt) && !readout?.error;
  const cancelCreate = () => {
    setSchedule("");
    setPrompt("");
    setSurfaceWhen("");
    setEndsWhen("");
    setCreating(false);
  };

  return (
    <section className="automation-panel" aria-label="Automation">
      <AutomationHeading status={automation ? automationStatusLabel(automation, now) : undefined} started={done === "started"} onRunNow={runNow} />

      <div className="automation-body" onKeyDown={(event) => {
        if (event.key === "Enter" && (MAC ? event.metaKey : event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!canSave) return;
          const command = automation ? { type: "automation.update", patch } as const : { type: "automation.save", draft } as const;
          if (!controls.available(command)) return;
          if (automation) save();
          else controls.dispatch(command);
          return;
        }
        if (automation || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancelCreate();
      }}>
        <div className="automation-field">
          <label htmlFor={scheduleId}>Schedule</label>
          <input
            id={scheduleId}
            className="automation-schedule"
            value={schedule}
            aria-invalid={readout?.error}
            aria-describedby={readout ? `${scheduleId}-readout` : undefined}
            placeholder="0 8 * * *"
            spellCheck={false}
            autoFocus={!automation}
            onInput={(event) => setSchedule(event.currentTarget.value)}
          />
          {readout && <small id={`${scheduleId}-readout`} className={readout.error ? "error" : undefined}>{readout.text}</small>}
          <SchedulePresets schedule={schedule} onPick={setSchedule} />
        </div>

        <label className="automation-field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            rows={10}
            placeholder={automation ? undefined : "What each run should do"}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>

        {oneShot ? null : (
          <label className="automation-field">
            <span>Notify me when</span>
            <input
              value={surfaceWhen}
              placeholder="Every run"
              onInput={(event) => setSurfaceWhen(event.currentTarget.value)}
            />
          </label>
        )}

        <label className="automation-field">
          <span>Stop when</span>
          <input
            value={endsWhen}
            placeholder="Repeats until removed"
            onInput={(event) => setEndsWhen(event.currentTarget.value)}
          />
        </label>

        {automation && (
          <dl className="automation-meta">
            {automationFacts(automation, lastFoundAt, lastChecked, now).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        )}

        {automation ? (
          <div className="automation-actions">
            <CommandButton command={{ type: "automation.update", patch }} type="button" className="automation-save primary" aria-keyshortcuts={MAC ? "Meta+Enter" : "Control+Enter"} data-tip={shortcutTip("Save", "Mod+Enter")} disabled={!canSave} onClick={save}>
              {done === "saved" && !dirty ? <><Check size={14} aria-hidden="true" />Saved</> : "Save"}
            </CommandButton>
            <CommandButton command={{ type: "automation.run-now" }} type="button" onClick={runNow}>
              {done === "started" ? <><Check size={14} aria-hidden="true" />Started</> : "Run now"}
            </CommandButton>
            <CommandButton command={{ type: "automation.update", patch: { paused: !automation.paused } }} type="button" aria-label={automation.paused ? "Resume automation" : "Pause automation"} onClick={() => onUpdate({ paused: !automation.paused })}>
              {automation.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{automation.paused ? "Resume" : "Pause"}
            </CommandButton>
            <ConfirmAction className="automation-remove" aria-label="Remove automation" data-tip={canDelete ? "Remove" : REMOTE_UNSUPPORTED} disabled={!canDelete} confirm="Remove" onConfirm={onDelete}><Trash2 size={14} /></ConfirmAction>
          </div>
        ) : (
          <div className="automation-actions">
            <CommandButton command={{ type: "automation.save", draft }} type="button" className="automation-save primary" aria-keyshortcuts={MAC ? "Meta+Enter" : "Control+Enter"} data-tip={shortcutTip("Create", "Mod+Enter")} disabled={!canSave}>Create</CommandButton>
            <button type="button" onClick={cancelCreate}>Cancel</button>
          </div>
        )}
      </div>
    </section>
  );
}
