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

/**
 * What a warning about `window` is called once dismissed. It names the window's period and how close
 * it is, so the warning comes back when the window reaches its limit or a new period runs low.
 */
export function usageWarningKey(engine: string, window: UsageWindow & { utilization: number }) {
  return `${engine}:${window.id}:${window.resetsAt ?? ""}:${window.utilization >= 100 ? "reached" : "near"}`;
}
