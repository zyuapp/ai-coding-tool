/** One rate-limit window as the panel draws it. */
export type UsageWindow = {
  id: string;
  label: string;
  /** Share of the window spent, 0-100. Null when the provider named the window without a number. */
  utilization: number | null;
  /** ISO 8601 instant the window resets, or null when the provider did not say. */
  resetsAt: string | null;
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
export function formatReset(resetsAt: string | null, now: number, timeZone: string) {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toLocaleDateString("en-US", { timeZone }) === new Date(now).toLocaleDateString("en-US", { timeZone });
  const day = at.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  return sameDay
    ? `Resets ${clock(at, timeZone)} (${timeZone})`
    : `Resets ${day} at ${clock(at, timeZone)} (${timeZone})`;
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
