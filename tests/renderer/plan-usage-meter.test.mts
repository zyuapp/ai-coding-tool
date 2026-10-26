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
    { id: "five_hour", label: "Current session", utilization: session, resetsAt: null },
    { id: "seven_day", label: "Current week (all models)", utilization: 20, resetsAt: null },
    { id: "model:Fable", label: "Current week (Fable)", utilization: fable, resetsAt: null, model: "Fable" },
  ],
});

test("the meter shows the fullest window the model spends, and lists them all on hover", async () => {
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Claude", model: "opus", usage: usage(64) }));
  try {
    const meter = view.container.querySelector(".plan-usage")!;
    assert.equal(meter.querySelector(".plan-usage-share")!.textContent, "64%");
    assert.equal(meter.classList.contains("near"), false);
    const rows = [...meter.querySelectorAll(".usage-card-label span:first-child")].map((row) => row.textContent);
    assert.deepEqual(rows, ["Current session", "Current week (all models)"], "another model's window stays out");
    assert.match(meter.querySelector(".usage-card-heading")!.textContent!, /Max plan/);
  } finally {
    await view.unmount();
  }
});

test("a model's own window counts toward its meter", async () => {
  const view = await mount(React.createElement(PlanUsageMeter, { engineLabel: "Claude", model: "fable", usage: usage(40, 86) }));
  try {
    assert.equal(view.container.querySelector(".plan-usage-share")!.textContent, "86%");
    assert.ok(view.container.querySelector(".plan-usage.near"));
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
