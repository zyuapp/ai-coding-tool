import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";
import { PlanUsageMeter, PlanUsageWarning } from "../../src/renderer/components/PlanUsageMeter.tsx";
import type { PlanUsage } from "../../src/domain/plan-usage.ts";
import { mount } from "../support/renderer-dom.mts";

const usage = (session: number, fable = 30): PlanUsage => ({
  status: "available",
  subscription: "max",
  windows: [
    { id: "five_hour", label: "Current session", utilization: session, resetsAt: null, period: "session", minutes: 300 },
    { id: "seven_day", label: "Current week (all models)", utilization: 20, resetsAt: null, period: "week", minutes: 10_080 },
    { id: "model:Fable", label: "Current week (Fable)", utilization: fable, resetsAt: null, model: "Fable", period: "week", minutes: 10_080 },
  ],
});

const shares = (container: HTMLElement) => [...container.querySelectorAll(".plan-usage-part")].map((part) => part.textContent);

test("the meter shows the session and the week, and lists every window the model spends on hover", async () => {
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Claude", model: "opus", usage: usage(64) }));
  try {
    const meter = view.container.querySelector(".plan-usage")!;
    assert.deepEqual(shares(view.container), ["5h64%", "Weekly20%"]);
    assert.equal(meter.querySelector(".near"), null);
    const rows = [...meter.querySelectorAll(".usage-card-label span:first-child")].map((row) => row.textContent);
    assert.deepEqual(rows, ["Current session", "Current week (all models)"], "another model's window stays out");
    assert.match(meter.querySelector(".usage-card-heading")!.textContent!, /Max plan/);
  } finally {
    await view.unmount();
  }
});

test("a model's own week counts when it is the fuller one, and only its row warns", async () => {
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Claude", model: "fable", usage: usage(40, 86) }));
  try {
    assert.deepEqual(shares(view.container), ["5h40%", "Weekly86%"]);
    assert.deepEqual([...view.container.querySelectorAll(".plan-usage-part")].map((row) => row.classList.contains("near")), [false, true]);
  } finally {
    await view.unmount();
  }
});

test("a plan with no session window shows its week alone", async () => {
  const weekly: PlanUsage = { status: "available", subscription: "plus", windows: [
    { id: "codex:primary", label: "Current week", utilization: 30, resetsAt: null, period: "week", minutes: 10_080 },
  ] };
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Codex", model: "gpt-6.1-sol", usage: weekly }));
  try {
    assert.deepEqual(shares(view.container), ["Weekly30%"]);
  } finally {
    await view.unmount();
  }
});

test("a plan that names no session or week shows its fullest window alone", async () => {
  const unnamed: PlanUsage = { status: "available", subscription: null, windows: [
    { id: "a", label: "Current 1-hour window", utilization: 10, resetsAt: null },
    { id: "b", label: "Current 1-day window", utilization: 30, resetsAt: null },
  ] };
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Codex", model: "gpt-6.1-sol", usage: unnamed }));
  try {
    assert.deepEqual(shares(view.container), ["30%"]);
  } finally {
    await view.unmount();
  }
});

test("an engine without plan limits draws no meter", async () => {
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Codex", model: "gpt-6.1-sol", usage: { status: "not-applicable" } }));
  try {
    assert.equal(view.container.querySelector(".plan-usage"), null);
  } finally {
    await view.unmount();
  }
});

test("the warning shows once a window runs low, and stays away once put away", async () => {
  const warned: string[] = [];
  const props = { engine: "claude", engineLabel: "Claude", model: "opus" as const, dismissed: [] as string[], limitPaused: false, onDismiss: (warning: string) => { warned.push(warning); } };
  const quiet = await mount(React.createElement(PlanUsageWarning, { ...props, usage: usage(79) }));
  try {
    assert.equal(quiet.container.querySelector(".plan-usage-warning"), null);
  } finally {
    await quiet.unmount();
  }

  const low = await mount(React.createElement(PlanUsageWarning, { ...props, usage: usage(86) }));
  try {
    assert.match(low.container.textContent!, /86% used/);
    assert.match(low.container.textContent!, /Claude · Current session/);
    low.container.querySelector<HTMLButtonElement>("button")!.click();
    assert.deepEqual(warned, ["claude:five_hour::near"]);
  } finally {
    await low.unmount();
  }

  const dismissed = await mount(React.createElement(PlanUsageWarning, { ...props, dismissed: warned, usage: usage(90) }));
  try {
    assert.equal(dismissed.container.querySelector(".plan-usage-warning"), null);
  } finally {
    await dismissed.unmount();
  }

  const reached = await mount(React.createElement(PlanUsageWarning, { ...props, dismissed: warned, usage: usage(100) }));
  try {
    assert.match(reached.container.textContent!, /Limit reached/, "reaching the limit brings a dismissed warning back");
  } finally {
    await reached.unmount();
  }

  const paused = await mount(React.createElement(PlanUsageWarning, { ...props, limitPaused: true, usage: usage(100) }));
  try {
    assert.equal(paused.container.querySelector(".plan-usage-warning"), null, "a paused thread already says so in the transcript");
  } finally {
    await paused.unmount();
  }
});
