import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { shortcutSettings } from "../../src/domain/shortcuts.ts";
import type { CliState } from "../../src/application/cli-installation.ts";

const { GeneralSettings } = await import("../../src/renderer/components/GeneralSettings.tsx");
const { ShortcutSettings } = await import("../../src/renderer/components/ShortcutSettings.tsx");

const OUTDATED: CliState = { status: { state: "installed", path: "/usr/local/bin/aic", current: false }, busy: false, error: null };

function general(cli: CliState, onSetCliInstalled: (installed: boolean) => void = () => {}, onReadCli: () => void = () => {}) {
  return React.createElement(GeneralSettings, {
    cli, onReadCli, onSetCliInstalled,
    chromeBrowser: false, onSetChromeBrowser() {}, notifications: false, onSetNotifications() {},
    onCheckForUpdates() {}, onOpenSourceLicenses() {},
  });
}

function cliButtons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>('[data-setting="general.cli"] button')];
}

test("updating the command relabels only Update, and both buttons wait for it", async () => {
  const calls: boolean[] = [];
  const view = await mount(general(OUTDATED, (installed) => calls.push(installed)));
  try {
    const [update] = cliButtons(view.container);
    await act(async () => update.click());
    assert.deepEqual(calls, [true]);
    await view.render(general({ ...OUTDATED, busy: true }, (installed) => calls.push(installed)));
    const [working, uninstall] = cliButtons(view.container);
    assert.equal(working.textContent, "Updating…");
    assert.equal(working.getAttribute("aria-busy"), "true");
    assert.equal(uninstall.textContent, "Uninstall");
    assert.equal(uninstall.disabled, true);
    assert.equal(uninstall.hasAttribute("aria-busy"), false);
  } finally {
    await view.unmount();
  }
});

test("uninstalling relabels only Uninstall", async () => {
  const calls: boolean[] = [];
  const view = await mount(general(OUTDATED, (installed) => calls.push(installed)));
  try {
    const uninstall = () => cliButtons(view.container).find((button) => button.textContent === "Uninstall")!;
    await act(async () => uninstall().click());
    const confirm = cliButtons(view.container).find((button) => button.textContent === "Uninstall aic")!;
    await act(async () => confirm.click());
    assert.deepEqual(calls, [false]);
    await view.render(general({ ...OUTDATED, busy: true }, (installed) => calls.push(installed)));
    assert.deepEqual(cliButtons(view.container).map((button) => button.textContent), ["Update", "Removing…"]);
  } finally {
    await view.unmount();
  }
});

test("a command that could not be read offers to look again", async () => {
  let reads = 0;
  const view = await mount(general({ status: null, busy: false, error: "Could not read the command." }, () => {}, () => { reads += 1; }));
  try {
    const before = reads;
    const again = query<HTMLButtonElement>(view.container, '[data-setting="general.cli"] button');
    assert.equal(again.textContent, "Check again");
    await act(async () => again.click());
    assert.equal(reads, before + 1);
  } finally {
    await view.unmount();
  }
});

test("each shortcut row's buttons name the shortcut they change", async () => {
  const shortcuts = shortcutSettings({});
  const first = shortcuts.find((shortcut) => shortcut.binding)!;
  const view = await mount(React.createElement(ShortcutSettings, {
    shortcuts, capturingShortcut: null, desktopShortcutUnavailable: null,
    onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {},
  }));
  try {
    const labels = [...view.container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    assert.ok(labels.includes(`Change ${first.label}`));
    assert.ok(labels.includes(`Clear ${first.label}`));
  } finally {
    await view.unmount();
  }
});
