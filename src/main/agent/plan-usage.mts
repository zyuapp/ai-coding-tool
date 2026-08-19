import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import type { PlanUsage, UsageWindow } from "../../domain/plan-usage.js";
import { packagedClaudeExecutable } from "./claude-agent-provider.mjs";

type QueryFactory = typeof query;
const READ_TIMEOUT_MS = 20_000;

/**
 * The methods that answer with plan usage, newest name first. The SDK ships this API under an
 * experimental name that changes when it stabilises, so a rename costs one entry here: the first
 * method this build exposes that answers in a shape `toPlanUsage` knows is the one that reports.
 */
const usageMethods = ["usage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"];
const noReader = "This build of the Claude SDK does not report plan usage.";
const unknownShape = "Claude reported usage in a shape this version of Claudex does not read.";

async function* idlePrompt() {
  await new Promise<void>(() => {});
}

function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readText(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function windowFrom(id: string, label: string, raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return { id, label, utilization: readNumber(record.utilization), resetsAt: readText(record.resets_at) };
}

/** Null when the answer is not a usage report at all, so the caller can try the next method. */
export function toPlanUsage(raw: unknown): PlanUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.rate_limits_available !== "boolean") return null;
  const limits = record.rate_limits;
  if (!record.rate_limits_available || !limits || typeof limits !== "object") return { status: "not-applicable" };

  const buckets = limits as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  const add = (window: UsageWindow | null) => {
    if (window && !windows.some((seen) => seen.label === window.label)) windows.push(window);
  };

  add(windowFrom("five_hour", "Current session", buckets.five_hour));
  add(windowFrom("seven_day", "Current week (all models)", buckets.seven_day));
  for (const entry of Array.isArray(buckets.model_scoped) ? buckets.model_scoped : []) {
    const name = entry && typeof entry === "object" ? readText((entry as Record<string, unknown>).display_name) : null;
    if (name) add(windowFrom(`model:${name}`, `Current week (${name})`, entry));
  }
  add(windowFrom("seven_day_opus", "Current week (Opus)", buckets.seven_day_opus));
  add(windowFrom("seven_day_sonnet", "Current week (Sonnet)", buckets.seven_day_sonnet));
  add(windowFrom("seven_day_oauth_apps", "Current week (apps)", buckets.seven_day_oauth_apps));

  if (windows.length === 0) return { status: "unavailable", message: "The plan reported no usage windows." };
  return { status: "available", subscription: readText(record.subscription_type), windows };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude did not answer in time.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the plan's rate-limit windows over a session that runs nothing: it carries no project, no
 * settings and no tools, and closes as soon as the control request answers.
 */
export async function readPlanUsage(queryFactory: QueryFactory = query, timeoutMs = READ_TIMEOUT_MS): Promise<PlanUsage> {
  let session: Query;
  try {
    session = queryFactory({
      prompt: idlePrompt(),
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: packagedClaudeExecutable(),
        settingSources: [],
        tools: [],
      },
    });
  } catch (cause) {
    return { status: "unavailable", message: describe(cause) };
  }

  try {
    let message = noReader;
    for (const method of usageMethods) {
      const read = (session as unknown as Record<string, unknown>)[method];
      if (typeof read !== "function") continue;
      try {
        const usage = toPlanUsage(await withTimeout(Promise.resolve((read as () => unknown).call(session)), timeoutMs));
        if (usage) return usage;
        message = unknownShape;
      } catch (cause) {
        message = describe(cause);
      }
    }
    return { status: "unavailable", message };
  } finally {
    try {
      session.close();
    } catch {
      /* A session that already went down needs no closing. */
    }
  }
}
