import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";
import { UsageSettings } from "../../src/renderer/components/UsageSettings.tsx";
import type { ComputerUsage, PlanUsageState } from "../../src/application/plan-limits.ts";
import { mount } from "../support/renderer-dom.mts";

const own: PlanUsageState = { read: 1, reading: [], dismissed: [], reports: { claude: { status: "available", subscription: "max", windows: [{ id: "five_hour", label: "Current session", utilization: 58, resetsAt: null }] }, codex: { status: "not-applicable" } } };

const computers: ComputerUsage[] = [
  { id: "mac", name: "MacBook", status: "connected", supported: true, usage: { read: 2, reading: ["codex"], dismissed: [], reports: { claude: { status: "available", subscription: "pro", windows: [{ id: "five_hour", label: "Current session", utilization: 92, resetsAt: null }] } } } },
  { id: "away", name: "Studio", status: "offline", supported: true, usage: null },
  { id: "old", name: "Old box", status: "connected", supported: false, usage: null },
  { id: "fresh", name: "Fresh", status: "connected", supported: true, usage: { read: 0, reading: [], dismissed: [], reports: {} } },
];

test("with paired computers a picker shows one computer's limits at a time", async () => {
  let refreshed = 0;
  const picked: (string | null)[] = [];
  const page = (selected: string | null) => React.createElement(UsageSettings, { usage: own, name: "omarchy", computers, selected, onSelect: (id) => picked.push(id), onRefresh: () => { refreshed += 1; }, timeZone: "UTC" });
  const view = await mount(page(null));
  try {
    const picker = () => view.container.querySelector<HTMLSelectElement>("select[aria-label='Computer']")!;
    const refresh = () => view.container.querySelector<HTMLButtonElement>(".settings-group-action button")!;
    assert.equal(refreshed, 1);
    assert.deepEqual([...picker().options].map((option) => option.textContent), ["This computer · omarchy", "MacBook", "Studio · Offline", "Old box", "Fresh"]);
    assert.equal(picker().value, "");
    assert.match(view.container.textContent!, /58% used/);
    assert.doesNotMatch(view.container.textContent!, /Pro plan/);
    assert.equal(refresh().disabled, false, "a slow computer elsewhere does not hold this one's refresh");

    picker().value = "mac";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(picked, ["mac"]);

    await view.render(page("mac"));
    assert.equal(picker().value, "mac");
    assert.match(view.container.textContent!, /Pro plan/);
    assert.doesNotMatch(view.container.textContent!, /58% used/);
    assert.ok(view.container.querySelector(".usage-window-fill.high"), "a computer near its limit is marked the same way");
    assert.match(view.container.textContent!, /Reading usage…/, "the provider still answering says so");
    assert.equal(refresh().disabled, true, "the computer on screen holds refresh while it reads");

    await view.render(page("away"));
    assert.match(view.container.textContent!, /Offline/);
    await view.render(page("old"));
    assert.match(view.container.textContent!, /Update AI Coding Tool on that computer/);
    await view.render(page("fresh"));
    assert.match(view.container.textContent!, /Not read yet\./);
    await view.render(page("gone"));
    assert.equal(picker().value, "", "a computer no longer paired falls back to this one");
  } finally {
    await view.unmount();
  }
});

test("with no paired computer the page is this computer's alone", async () => {
  const view = await mount(React.createElement(UsageSettings, { usage: own, onRefresh() {}, timeZone: "UTC" }));
  try {
    assert.equal(view.container.querySelector("select"), null);
    assert.match(view.container.textContent!, /58% used/);
  } finally {
    await view.unmount();
  }
});

test("a provider this computer could not read offers to read it again beside its error", async () => {
  const failing: PlanUsageState = { ...own, reports: { ...own.reports, codex: { status: "unavailable", message: "Codex did not answer." } } };
  const paired: ComputerUsage[] = [{ id: "mac", name: "MacBook", status: "connected", supported: true, usage: failing }];
  let refreshed = 0;
  const page = (usage: PlanUsageState, selected: string | null) => React.createElement(UsageSettings, { usage, computers: paired, selected, onRefresh: () => { refreshed += 1; }, timeZone: "UTC" });
  const view = await mount(page(failing, "mac"));
  try {
    const retry = () => view.container.querySelector<HTMLButtonElement>(".settings-error button");
    assert.equal(retry(), null, "another computer's limits are not read from here");

    await view.render(page(failing, null));
    assert.equal(retry()!.textContent, "Try again");
    retry()!.click();
    assert.equal(refreshed, 2);

    await view.render(page({ ...failing, reading: ["codex"] }, null));
    assert.equal(retry()!.disabled, true);
    assert.equal(retry()!.textContent, "Reading…");
  } finally {
    await view.unmount();
  }
});
