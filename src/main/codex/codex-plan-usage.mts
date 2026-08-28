import type { PlanUsage, UsageWindow } from "../../domain/plan-usage.js";
import { CLIENT_INFO, codexAppServer, connectAppServer, type AppServerClient, type AppServerCommand } from "./app-server-client.mjs";
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.js";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.js";
import type { RateLimitWindow } from "./protocol/v2/RateLimitWindow.js";

export type UsageClient = Pick<AppServerClient, "initialize" | "request" | "close">;
export type UsageConnect = (command: AppServerCommand) => UsageClient;

const READ_TIMEOUT_MS = 20_000;

function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Codex did not answer in time.")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function resetInstant(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const instant = new Date(seconds * 1_000);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function windowName(kind: "primary" | "secondary", minutes: number | null) {
  if (minutes === 300) return "Current session";
  if (minutes === 10_080) return "Current week";
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return kind === "primary" ? "Primary limit" : "Secondary limit";
  if (minutes % 1_440 === 0) return `Current ${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `Current ${minutes / 60}-hour window`;
  return `Current ${minutes}-minute window`;
}

function usageWindow(id: string, label: string, kind: "primary" | "secondary", value: RateLimitWindow | null): UsageWindow | null {
  if (!value || !Number.isFinite(value.usedPercent)) return null;
  return {
    id: `${id}:${kind}`,
    label: `${label}${windowName(kind, value.windowDurationMins)}`,
    utilization: value.usedPercent,
    resetsAt: resetInstant(value.resetsAt),
  };
}

function snapshots(response: GetAccountRateLimitsResponse): Array<[string, RateLimitSnapshot]> {
  const named = Object.entries(response.rateLimitsByLimitId ?? {}).filter((entry): entry is [string, RateLimitSnapshot] => Boolean(entry[1]));
  return named.length ? named : [[response.rateLimits.limitId ?? "codex", response.rateLimits]];
}

function limitName(id: string, snapshot: RateLimitSnapshot) {
  const name = snapshot.limitName ?? id;
  return name.toLowerCase() === "codex" ? "Codex" : name;
}

/** Translates Codex's account windows into the same report the Claude reader returns. */
export function toCodexPlanUsage(response: GetAccountRateLimitsResponse, accountPlan: string | null = null): PlanUsage {
  const limits = snapshots(response);
  const windows: UsageWindow[] = [];
  for (const [id, snapshot] of limits) {
    const name = limits.length > 1 ? `${limitName(id, snapshot)} · ` : "";
    const primary = usageWindow(id, name, "primary", snapshot.primary);
    const secondary = usageWindow(id, name, "secondary", snapshot.secondary);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
  }
  if (windows.length === 0) return { status: "not-applicable" };
  return {
    status: "available",
    subscription: limits.find(([, snapshot]) => snapshot.planType)?.[1].planType ?? accountPlan,
    windows,
  };
}

/** Reads Codex plan limits over a short-lived app-server connection with no thread or run. */
export async function readCodexPlanUsage(connect: UsageConnect = connectAppServer, timeoutMs = READ_TIMEOUT_MS): Promise<PlanUsage> {
  let client: UsageClient;
  try {
    client = connect(codexAppServer());
  } catch (cause) {
    return { status: "unavailable", message: describe(cause) };
  }

  try {
    await withTimeout(client.initialize(CLIENT_INFO), timeoutMs);
    const account = await withTimeout(client.request("account/read", { refreshToken: false }), timeoutMs);
    if (account.account?.type !== "chatgpt") return { status: "not-applicable" };
    const response = await withTimeout(client.request("account/rateLimits/read"), timeoutMs);
    return toCodexPlanUsage(response, account.account.planType);
  } catch (cause) {
    return { status: "unavailable", message: describe(cause) };
  } finally {
    try {
      await client.close();
    } catch {
      /* A server that already stopped needs no closing. */
    }
  }
}
