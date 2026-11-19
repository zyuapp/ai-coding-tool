/** One rate-limit window as the panel draws it. */
export type UsageWindow = {
  id: string;
  label: string;
  /** Share of the window spent, 0-100. Null when the provider named the window without a number. */
  utilization: number | null;
  /** ISO 8601 instant the window resets, or null when the provider did not say. */
  resetsAt: string | null;
  /** The model a window counts on its own, by the name the provider gives it. Absent for one every model shares. */
  model?: string;
  /** Which recurring period of the plan a window covers, for the session and week the composer draws apart. */
  period?: "session" | "week";
  /** How long the window runs before it resets. */
  minutes?: number;
};

/**
 * What one engine can say about the plan behind its account on this machine. An engine that cannot
 * answer reports why rather than throwing, so the panel always has something to draw.
 */
export type PlanUsage =
  | { status: "available"; subscription: string | null; windows: UsageWindow[] }
  /** The engine is signed out or bills somewhere plan limits do not apply. */
  | { status: "not-applicable" }
  | { status: "unavailable"; message: string };

export function formatShare(utilization: number | null) {
  if (utilization === null) return "Not reported";
  return `${Math.round(Math.min(Math.max(utilization, 0), 100))}% used`;
}

export function barShare(utilization: number | null) {
  if (utilization === null) return 0;
  return Math.min(Math.max(utilization, 0), 100);
}

function clock(at: Date, timeZone: string) {
  return at.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
}

/** A window resetting today reads as a time; one further out carries the day it lands on. */
export function formatReset(resetsAt: string | null, now: number, timeZone: string, { zone = true } = {}) {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toLocaleDateString("en-US", { timeZone }) === new Date(now).toLocaleDateString("en-US", { timeZone });
  const day = at.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  const suffix = zone ? ` (${timeZone})` : "";
  return sameDay
    ? `Resets ${clock(at, timeZone)}${suffix}`
    : `Resets ${day} at ${clock(at, timeZone)}${suffix}`;
}

const PLAN_LABELS: Record<string, string> = {
  prolite: "Pro",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
};

export function planLabel(subscription: string | null) {
  if (!subscription) return null;
  const label = PLAN_LABELS[subscription] ?? subscription.split("_").map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
  return `${label} plan`;
}

/** Where a window starts to warn that it is running out. */
export const NEAR_LIMIT_SHARE = 80;

/** Whether a window counts a model named `label`, which a provider may call by its bare name or a longer one. */
function countsModel(window: UsageWindow, label: string) {
  if (window.model === undefined) return true;
  return window.model.toLowerCase().split(/[^a-z0-9.]+/).includes(label.toLowerCase());
}

/** The windows a run on the model named `label` spends: every shared window, and the model's own. */
export function windowsFor(usage: PlanUsage | undefined, label: string): UsageWindow[] {
  return usage?.status === "available" ? usage.windows.filter((window) => countsModel(window, label)) : [];
}

/** The window closest to running out. Null when none reports a number. */
export function tightestWindow(windows: readonly UsageWindow[]): (UsageWindow & { utilization: number }) | null {
  let tightest: (UsageWindow & { utilization: number }) | null = null;
  for (const window of windows) {
    if (window.utilization !== null && (!tightest || window.utilization > tightest.utilization)) tightest = { ...window, utilization: window.utilization };
  }
  return tightest;
}

/** A window's length in a few characters: 5h, 1d, Weekly. Null when the provider did not say. */
export function windowSpan(window: UsageWindow) {
  const { minutes } = window;
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** The session window and the fullest weekly one, each null when the plan does not report it. */
export function sessionAndWeek(windows: readonly UsageWindow[]) {
  return {
    session: tightestWindow(windows.filter((window) => window.period === "session")),
    week: tightestWindow(windows.filter((window) => window.period === "week")),
  };
}

/**
 * What a warning about `window` is called once dismissed: the window and how close it is, then the
 * instant it resets. The dismissal holds until that instant, so a reset time that drifts between
 * reads keeps it, and the warning comes back when the window reaches its limit or a new period runs low.
 */
export function usageWarningKey(engine: string, window: UsageWindow & { utilization: number }) {
  const resets = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
  return `${engine}:${window.id}:${window.utilization >= 100 ? "reached" : "near"}@${Number.isFinite(resets) ? resets : ""}`;
}

function warningParts(key: string) {
  const at = key.lastIndexOf("@");
  const until = at < 0 ? NaN : Number(key.slice(at + 1) || NaN);
  return { subject: at < 0 ? key : key.slice(0, at), until: Number.isFinite(until) ? until : null };
}

/** Whether the user put away the warning `key` names and its window has not reset since. */
export function usageWarningDismissed(dismissed: readonly string[], key: string, now: number) {
  const { subject } = warningParts(key);
  return dismissed.some((entry) => {
    const kept = warningParts(entry);
    return kept.subject === subject && (kept.until === null || now < kept.until);
  });
}

/** `dismissed` with `key` put away, in place of any earlier dismissal of the same warning. */
export function withUsageWarningDismissed(dismissed: readonly string[], key: string) {
  const { subject } = warningParts(key);
  return [...dismissed.filter((entry) => warningParts(entry).subject !== subject), key].slice(-MAX_DISMISSED_WARNINGS);
}

export const MAX_DISMISSED_WARNINGS = 20;
