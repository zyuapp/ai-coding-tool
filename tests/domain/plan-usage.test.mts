import assert from "node:assert/strict";
import { test } from "vitest";
import { formatReset, formatShare, planLabel, type PlanUsage } from "../../src/domain/plan-usage.ts";
import { readPlanUsage, toPlanUsage } from "../../src/main/agent/plan-usage.mts";

type QueryFactory = typeof import("@anthropic-ai/claude-agent-sdk").query;
type QueryCall = Parameters<QueryFactory>[0];
type Capture = { prompt?: QueryCall["prompt"]; options?: QueryCall["options"]; closed?: boolean };

function sessionFactory(methods: Record<string, () => unknown>, capture: Capture = {}): QueryFactory {
  return (({ prompt, options }: QueryCall) => {
    capture.prompt = prompt;
    capture.options = options;
    return {
      ...methods,
      close() {
        capture.closed = true;
        methods.close?.();
      },
    };
  }) as unknown as QueryFactory;
}

function available(raw: unknown): Extract<PlanUsage, { status: "available" }> {
  const usage = toPlanUsage(raw);
  assert.equal(usage?.status, "available");
  return usage as Extract<PlanUsage, { status: "available" }>;
}

const report = {
  session: { total_cost_usd: 1.5, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 17, resets_at: "2026-08-18T08:19:00Z" },
    seven_day: { utilization: 19.4, resets_at: "2026-08-22T10:59:00Z" },
    model_scoped: [{ display_name: "Fable", utilization: 2, resets_at: "2026-08-22T10:59:00Z" }],
  },
};

test("a usage report becomes the windows the panel draws, newest window first", () => {
  const usage = available(report);

  assert.equal(usage.subscription, "max");
  assert.deepEqual(usage.windows.map((window) => window.label), [
    "Current session",
    "Current week (all models)",
    "Current week (Fable)",
  ]);
  assert.deepEqual(usage.windows[0], { id: "five_hour", label: "Current session", utilization: 17, resetsAt: "2026-08-18T08:19:00Z" });
  assert.equal(usage.windows[2].id, "model:Fable");
});

test("a window the provider names without numbers still draws, and a model listed twice draws once", () => {
  const usage = available({
    rate_limits_available: true,
    subscription_type: null,
    rate_limits: {
      five_hour: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: "Opus", utilization: 4, resets_at: null }],
      seven_day_opus: { utilization: 9, resets_at: null },
    },
  });

  assert.deepEqual(usage.windows.map((window) => window.label), ["Current session", "Current week (Opus)"]);
  assert.deepEqual(usage.windows[0], { id: "five_hour", label: "Current session", utilization: null, resetsAt: null });
  assert.equal(usage.windows[1].utilization, 4);
  assert.equal(usage.subscription, null);
});

test("a session that plan limits do not cover says so, and one that answers nothing is unavailable", () => {
  assert.deepEqual(toPlanUsage({ rate_limits_available: false, rate_limits: null }), { status: "not-applicable" });
  assert.deepEqual(toPlanUsage({ rate_limits_available: true, rate_limits: null }), { status: "not-applicable" });
  assert.equal(toPlanUsage({ rate_limits_available: true, rate_limits: {} })?.status, "unavailable");
});

test("an answer that is not a usage report at all is left for the next method", () => {
  assert.equal(toPlanUsage(undefined), null);
  assert.equal(toPlanUsage("nope"), null);
  assert.equal(toPlanUsage({ rate_limits: {} }), null);
});

test("usage reads over a session that carries no project, no settings and no tools", async () => {
  const capture: Capture = {};
  const usage = await readPlanUsage(sessionFactory({ usage: async () => report }, capture));

  assert.equal(usage.status, "available");
  assert.ok(capture.options);
  assert.deepEqual(capture.options.settingSources, []);
  assert.deepEqual(capture.options.tools, []);
  assert.ok(capture.options.cwd);
  assert.equal(capture.options.cwd.length > 0, true);
  assert.equal(capture.closed, true);
});

test("the stable method answers first, and the experimental one answers when it is the only reader", async () => {
  const called: string[] = [];
  const both = await readPlanUsage(sessionFactory({
    usage: async () => { called.push("usage"); return report; },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { called.push("experimental"); return report; },
  }));
  assert.equal(both.status, "available");
  assert.deepEqual(called, ["usage"]);

  const experimental = await readPlanUsage(sessionFactory({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => report,
  }));
  assert.equal(experimental.status, "available");
});

test("a reader answering in an unknown shape hands over to the next one", async () => {
  const usage = await readPlanUsage(sessionFactory({
    usage: async () => ({ limits: "reshaped" }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => report,
  }));

  assert.equal(usage.status, "available");
});

test("a build with no reader, a throwing reader, and a silent reader each report why", async () => {
  const capture: Capture = {};
  const missing = await readPlanUsage(sessionFactory({}, capture));
  assert.equal(missing.status, "unavailable");
  if (missing.status !== "unavailable") return;
  assert.match(missing.message, /does not report plan usage/);
  assert.equal(capture.closed, true);

  const threw = await readPlanUsage(sessionFactory({ usage: async () => { throw new Error("control request failed"); } }));
  assert.deepEqual(threw, { status: "unavailable", message: "control request failed" });

  const reshaped = await readPlanUsage(sessionFactory({ usage: async () => 42 }));
  assert.equal(reshaped.status, "unavailable");
  if (reshaped.status !== "unavailable") return;
  assert.match(reshaped.message, /shape this version of AI Coding Tool does not read/);

  const hung = await readPlanUsage(sessionFactory({ usage: () => new Promise(() => {}) }), 5);
  assert.deepEqual(hung, { status: "unavailable", message: "Claude did not answer in time." });
});

test("a session that cannot start, or cannot close, still reports rather than throwing", async () => {
  const unstartable = await readPlanUsage(() => { throw new Error("agent is unavailable"); });
  assert.deepEqual(unstartable, { status: "unavailable", message: "agent is unavailable" });

  const usage = await readPlanUsage(sessionFactory({
    usage: async () => report,
    close() { throw new Error("already gone"); },
  }));
  assert.equal(usage.status, "available");
});

test("a window resetting today reads as a time, and a later one carries its day", () => {
  const zone = "America/Los_Angeles";
  const now = Date.parse("2026-08-18T20:00:00Z");

  assert.equal(formatReset("2026-08-18T08:19:00Z", now, zone), "Resets 1:19am (America/Los_Angeles)");
  assert.equal(formatReset("2026-08-22T10:59:00Z", now, zone), "Resets Aug 22 at 3:59am (America/Los_Angeles)");
  assert.equal(formatReset(null, now, zone), null);
  assert.equal(formatReset("not a time", now, zone), null);
});

test("a share reads as a whole percentage, and a plan reads as its own name", () => {
  assert.equal(formatShare(19.4), "19% used");
  assert.equal(formatShare(0), "0% used");
  assert.equal(formatShare(140), "100% used");
  assert.equal(formatShare(null), "Not reported");
  assert.equal(planLabel("max"), "Max plan");
  assert.equal(planLabel("prolite"), "Pro plan");
  assert.equal(planLabel("self_serve_business_usage_based"), "Business plan");
  assert.equal(planLabel(null), null);
});
