import assert from "node:assert/strict";
import { test } from "vitest";
import { readCodexPlanUsage, toCodexPlanUsage, type UsageConnect } from "../../../src/main/codex/codex-plan-usage.mts";
import type { GetAccountRateLimitsResponse } from "../../../src/main/codex/protocol/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "../../../src/main/codex/protocol/v2/RateLimitSnapshot.ts";
import { FakeCodexClient, type Script } from "../../support/codex-client.mjs";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: "Codex",
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  };
}

const response: GetAccountRateLimitsResponse = {
  rateLimits: snapshot({
    primary: { usedPercent: 17.4, windowDurationMins: 300, resetsAt: Date.parse("2026-08-28T01:30:00Z") / 1_000 },
    secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: Date.parse("2026-09-03T01:30:00Z") / 1_000 },
  }),
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
};

test("Codex rate limits become the same session and week windows as Claude usage", () => {
  const usage = toCodexPlanUsage(response);
  assert.equal(usage.status, "available");
  if (usage.status !== "available") return;
  assert.equal(usage.subscription, "pro");
  assert.deepEqual(usage.windows, [
    { id: "codex:primary", label: "Current session", utilization: 17.4, resetsAt: "2026-08-28T01:30:00.000Z" },
    { id: "codex:secondary", label: "Current week", utilization: 42, resetsAt: "2026-09-03T01:30:00.000Z" },
  ]);
});

test("multiple Codex limit buckets keep their names and stable order, and an empty answer has no plan limits", () => {
  const usage = toCodexPlanUsage({
    ...response,
    rateLimitsByLimitId: {
      review: snapshot({ limitId: "review", limitName: "Code review", planType: null, primary: { usedPercent: 20, windowDurationMins: 1_440, resetsAt: null } }),
      codex: snapshot({ primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null } }),
    },
  });
  assert.equal(usage.status, "available");
  if (usage.status !== "available") return;
  assert.deepEqual(usage.windows.map((window) => window.label), ["Codex · Current 1-hour window", "Code review · Current 1-day window"]);

  assert.deepEqual(toCodexPlanUsage({ ...response, rateLimits: snapshot({ planType: null }) }, "plus"), { status: "not-applicable" });
});

function harness(script: Script, handshake?: () => Promise<never>) {
  const clients: FakeCodexClient[] = [];
  const connect: UsageConnect = (command) => {
    const client = new FakeCodexClient(command, script, handshake);
    clients.push(client);
    return client;
  };
  return { connect, clients };
}

test("usage reads the Codex account and limits over a short-lived app server", async () => {
  const { connect, clients } = harness({
    "account/read": () => ({ account: { type: "chatgpt", email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: true }),
    "account/rateLimits/read": () => response,
  });
  const usage = await readCodexPlanUsage(connect);

  assert.equal(usage.status, "available");
  assert.deepEqual(clients[0].sent.map((call) => call.method), ["initialize", "account/read", "account/rateLimits/read"]);
  assert.equal(clients[0].closed, true);
  assert.deepEqual(clients[0].command.args, ["app-server", "--listen", "stdio://"]);
});

test("a non-ChatGPT account has no plan limits, while failures and timeouts report why", async () => {
  const signedOut = harness({ "account/read": () => ({ account: null, requiresOpenaiAuth: true }) });
  assert.deepEqual(await readCodexPlanUsage(signedOut.connect), { status: "not-applicable" });
  assert.deepEqual(signedOut.clients[0].sent.map((call) => call.method), ["initialize", "account/read"]);

  const failed = harness({
    "account/read": () => ({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }),
    "account/rateLimits/read": () => { throw new Error("rate limits unavailable"); },
  });
  assert.deepEqual(await readCodexPlanUsage(failed.connect), { status: "unavailable", message: "rate limits unavailable" });

  const silent = harness({}, () => new Promise(() => {}));
  assert.deepEqual(await readCodexPlanUsage(silent.connect, 5), { status: "unavailable", message: "Codex did not answer in time." });
  assert.equal(silent.clients[0].closed, true);
});

test("a Codex server that cannot start reports the startup failure", async () => {
  const usage = await readCodexPlanUsage(() => { throw new Error("Codex is not bundled."); });
  assert.deepEqual(usage, { status: "unavailable", message: "Codex is not bundled." });
});
