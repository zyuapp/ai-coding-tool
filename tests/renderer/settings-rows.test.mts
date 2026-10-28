import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { shortcutSettings } from "../../src/domain/shortcuts.ts";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { openSettingsPage, renderSettingsPanel } from "../support/settings-panel.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");

test("a status circle says whether its step is done, and a row with no step draws no circle", async () => {
  window.desktop = fakeDesktop({ cliStatus: async () => ({ state: "missing", path: "/usr/local/bin/aic" }) });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");
  const status = query<HTMLElement>(view.container, '[data-setting="general.cli"] .setting-status');
  assert.equal(status.classList.contains("pending"), true);
  assert.equal(status.textContent, "Not done");
  const plain = query<HTMLElement>(view.container, '[data-setting="general.notifications"]');
  assert.equal(plain.querySelector(".setting-status"), null);
  assert.equal(plain.classList.contains("plain"), true);
  await view.unmount();
});

test("replacing another program's command asks first and names its path", async () => {
  const calls: string[] = [];
  window.desktop = fakeDesktop({
    cliStatus: async () => ({ state: "conflict", path: "/usr/local/bin/aic" }),
    installCli: async () => { calls.push("install"); return { state: "installed", path: "/usr/local/bin/aic" }; },
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");
  const button = () => query<HTMLButtonElement>(view.container, '[data-setting="general.cli"] button');
  assert.equal(button().textContent, "Replace it");
  await act(async () => { button().click(); });
  assert.deepEqual(calls, []);
  assert.equal(button().textContent, "Replace /usr/local/bin/aic");
  await act(async () => { button().click(); });
  assert.deepEqual(calls, ["install"]);
  await view.unmount();
});

test("a half-asked confirmation is taken back when the focus leaves it", async () => {
  let resets = 0;
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "shortcuts", shortcuts: shortcutSettings({ "project.start": "Mod+Shift+O" }), onResetShortcuts: () => { resets++; } }));
  await act(async () => {});
  const labels = () => [...view.container.querySelectorAll<HTMLButtonElement>(".settings-group-action button")].map((button) => button.textContent);
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-group-action button")].find((button) => button.textContent === "Restore defaults")).click(); });
  assert.ok(labels().includes("Restore all"));
  const search = query<HTMLInputElement>(view.container, 'input[aria-label="Search settings"]');
  await act(async () => { search.focus(); });
  assert.ok(!labels().includes("Restore all"));
  assert.ok(labels().includes("Restore defaults"));
  assert.equal(dom.window.document.activeElement, search, "the focus stays where the user sent it");
  assert.equal(resets, 0);
  await view.unmount();
});

test("a switch row's name and description toggle the switch too", async () => {
  const changed: boolean[] = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ notifications: true, onSetNotifications: (enabled) => changed.push(enabled) }));
  await act(async () => {});
  await act(async () => { query<HTMLElement>(view.container, '[data-setting="general.notifications"] .setting-row-text p').click(); });
  assert.deepEqual(changed, [false]);
  await view.unmount();
});

test("the updates row follows a found update through download to restart", async () => {
  const calls: string[] = [];
  const update = (state: NonNullable<SettingsPanelProps["appUpdate"]>["state"]) => ({ state, onDownload: () => calls.push("download"), onInstall: () => calls.push("install") });
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ appUpdate: { ...update({ status: "idle" }), version: "8.1.0" } }));
  await act(async () => {});
  const row = () => query<HTMLElement>(view.container, '[data-setting="general.updates"]');
  assert.equal(query(row(), "button").textContent, "Check for updates");
  assert.match(row().textContent, /Version 8\.1\.0\./, "the running version is named while nothing newer is known");

  await view.render(renderSettingsPanel({ appUpdate: update({ status: "available", version: "9.0.0" }) }));
  assert.match(row().textContent, /Version 9\.0\.0 is available/);
  await act(async () => { query<HTMLButtonElement>(row(), "button").click(); });

  await view.render(renderSettingsPanel({ appUpdate: update({ status: "downloading", version: "9.0.0", percent: 40 }) }));
  assert.equal(query(row(), '[role="status"]').textContent, "40%");
  assert.equal(row().querySelector("button"), null, "a download in progress offers nothing to press");

  await view.render(renderSettingsPanel({ appUpdate: update({ status: "ready", version: "9.0.0" }) }));
  await act(async () => { query<HTMLButtonElement>(row(), "button").click(); });
  assert.deepEqual(calls, ["download", "install"]);
  await view.unmount();
});

test("a font picker says it is still reading installed fonts", async () => {
  let answer: (fonts: { family: string }[]) => void = () => {};
  (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts = () => new Promise((resolve) => { answer = resolve; });
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance" }));
  await act(async () => {});
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Interface font:"]').click(); });
  assert.match(query(view.container, ".font-select-popover").textContent, /Reading installed fonts…/);
  await act(async () => { answer([{ family: "Avenir Next" }]); });
  assert.doesNotMatch(query(view.container, ".font-select-popover").textContent, /Reading installed fonts/);
  assert.match(query(view.container, ".font-select-popover").textContent, /Avenir Next/);
  delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
  await view.unmount();
});

test("a size field names its range", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance" }));
  await act(async () => {});
  assert.match(query(view.container, '[data-setting="appearance.reading-size"] .size-range').textContent, /^\d+–\d+ px$/);
  await view.unmount();
});

test("a landed control keeps a still mark until the user next acts", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", initialSetting: "appearance.mono-font" }));
  await act(async () => {});
  const row = query<HTMLElement>(view.container, '[data-setting="appearance.mono-font"]');
  assert.equal(row.hasAttribute("data-landed"), true);
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a" })); });
  assert.equal(row.hasAttribute("data-landed"), false);
  await view.unmount();
});

test("a size field names its unit, and the unit belongs to the field", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", readingSize: 15 }));
  await act(async () => {});
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Conversation text size"]');
  const unit = item(field.closest("label"));
  assert.equal(unit.textContent, "px");
  assert.equal(field.labels?.[0], unit);
  await view.unmount();
});
