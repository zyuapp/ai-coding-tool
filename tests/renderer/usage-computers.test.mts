import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";
import { UsageSettings } from "../../src/renderer/components/UsageSettings.tsx";
import type { ComputerUsage, PlanUsageState } from "../../src/application/plan-limits.ts";
import { mount } from "../support/renderer-dom.mts";

const own: PlanUsageState = { read: 1, reading: [], dismissed: [], reports: { claude: { status: "available", subscription: "max", windows: [{ id: "five_hour", label: "Current session", utilization: 58, resetsAt: null }] }, codex: { status: "not-applicable" } } };

test("with paired computers the page lists each computer's own limits under its name", async () => {
  const computers: ComputerUsage[] = [
    { id: "mac", name: "MacBook", status: "connected", supported: true, usage: { read: 2, reading: ["codex"], dismissed: [], reports: { claude: { status: "available", subscription: "pro", windows: [{ id: "five_hour", label: "Current session", utilization: 92, resetsAt: null }] } } } },
    { id: "away", name: "Studio", status: "offline", supported: true, usage: null },
    { id: "old", name: "Old box", status: "connected", supported: false, usage: null },
    { id: "fresh", name: "Fresh", status: "connected", supported: true, usage: { read: 0, reading: [], dismissed: [], reports: {} } },
  ];
  let refreshed = 0;
  const view = await mount(React.createElement(UsageSettings, { usage: own, name: "omarchy", computers, onRefresh: () => { refreshed += 1; }, timeZone: "UTC" }));
  try {
    const section = (id: string) => view.container.querySelector(`[data-usage-computer='${id}']`)!;
    assert.equal(refreshed, 1);
    assert.match(section("this").querySelector("h4")!.textContent!, /This computer · omarchy/);
    assert.match(section("this").textContent!, /58% used/);
    assert.match(section("mac").textContent!, /Pro plan/);
    assert.ok(section("mac").querySelector(".usage-window-fill.high"), "a computer near its limit is marked the same way");
    assert.match(section("mac").textContent!, /Reading usage…/, "the provider still answering says so");
    assert.match(section("away").textContent!, /Offline/);
    assert.match(section("old").textContent!, /Update AI Coding Tool on that computer/);
    assert.match(section("fresh").textContent!, /Not read yet\./);
    assert.equal(view.container.querySelector<HTMLButtonElement>(".settings-group-action button")!.disabled, false, "a slow computer elsewhere does not hold this one's refresh");
  } finally {
    await view.unmount();
  }
});

test("with no paired computer the page is this computer's alone", async () => {
  const view = await mount(React.createElement(UsageSettings, { usage: own, onRefresh() {}, timeZone: "UTC" }));
  try {
    assert.equal(view.container.querySelector(".usage-computer"), null);
    assert.match(view.container.textContent!, /58% used/);
  } finally {
    await view.unmount();
  }
});

test("a provider this computer could not read offers to read it again beside its error", async () => {
  const failing: PlanUsageState = { ...own, reports: { ...own.reports, codex: { status: "unavailable", message: "Codex did not answer." } } };
  const paired: ComputerUsage[] = [{ id: "mac", name: "MacBook", status: "connected", supported: true, usage: failing }];
  let refreshed = 0;
  const view = await mount(React.createElement(UsageSettings, { usage: failing, computers: paired, onRefresh: () => { refreshed += 1; }, timeZone: "UTC" }));
  try {
    const retry = (id: string) => view.container.querySelector<HTMLButtonElement>(`[data-usage-computer='${id}'] .settings-error button`);
    assert.equal(retry("mac"), null, "another computer's limits are not read from here");
    assert.equal(retry("this")!.textContent, "Try again");
    retry("this")!.click();
    assert.equal(refreshed, 2);

    await view.render(React.createElement(UsageSettings, { usage: { ...failing, reading: ["codex"] }, computers: paired, onRefresh() {}, timeZone: "UTC" }));
    assert.equal(retry("this")!.disabled, true);
    assert.equal(retry("this")!.textContent, "Reading…");
  } finally {
    await view.unmount();
  }
});
