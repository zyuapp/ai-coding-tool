import { seedTaskWithSubagent } from "../support/subagents.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand } from "../../src/contracts/ipc.ts";

import type { CliStatus } from "../../src/domain/cli.ts";
import type { AgentEngine } from "../../src/domain/agent-engine.ts";
import type { PlanUsage } from "../../src/domain/plan-usage.ts";
import { shortcutSettings } from "../../src/domain/shortcuts.ts";

import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { SettingsSection } from "../../src/domain/settings-section.ts";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";
import { openSettingsPage, renderSettingsPanel } from "../support/settings-panel.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { settleUntil } from "../support/settle.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");
const { SettingsPanel } = await import("../../src/renderer/components/SettingsPanel.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

test("General Settings keeps updates and licenses reachable without the app menu", async () => {
  const calls: string[] = [];
  window.desktop = fakeDesktop({
    checkForUpdates: () => { calls.push("updates"); },
    openSourceLicenses: async () => { calls.push("licenses"); },
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");
  await act(async () => { query<HTMLButtonElement>(view.container, '[data-setting="general.updates"] button').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, '[data-setting="general.licenses"] button').click(); });
  assert.deepEqual(calls, ["updates", "licenses"]);
  await view.unmount();
});

test("the general section installs the aic command and takes it back", async () => {
  const calls: string[] = [];
  let status: CliStatus = { state: "missing", path: "/usr/local/bin/aic" };
  window.desktop = fakeDesktop({
    cliStatus: async () => status,
    installCli: async () => { calls.push("install"); status = { state: "installed", path: "/usr/local/bin/aic" }; return status; },
    uninstallCli: async () => { calls.push("uninstall"); status = { state: "missing", path: "/usr/local/bin/aic" }; return status; },
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");
  const button = () => query<HTMLButtonElement>(view.container, '[data-setting="general.cli"] button');
  assert.match(view.container.textContent, /Terminal command/);
  assert.equal(button().textContent, "Install");

  await act(async () => { button().click(); });
  assert.equal(button().textContent, "Uninstall");
  assert.match(view.container.textContent, /Installed at \/usr\/local\/bin\/aic/);

  await act(async () => { button().click(); });
  assert.deepEqual(calls, ["install"], "one press on Uninstall only asks");
  assert.equal(button().textContent, "Uninstall aic");
  await act(async () => { button().click(); });
  assert.deepEqual(calls, ["install", "uninstall"]);
  assert.equal(button().textContent, "Install");
  await view.unmount();
});

test("the Linux command explains when its user-local bin folder is not on PATH", async () => {
  window.desktop = fakeDesktop({
    cliStatus: async () => ({ state: "installed", path: "/home/me/.local/bin/aic", onPath: false }),
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");

  assert.match(view.container.textContent, /Add its folder to PATH to run aic by name/);
  await view.unmount();
});

test("an install the password prompt refuses is reported, not swallowed", async () => {
  window.desktop = fakeDesktop({ installCli: async () => { throw new Error("Cancelled."); } });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "General");
  await act(async () => { query<HTMLButtonElement>(view.container, '[data-setting="general.cli"] button').click(); });

  assert.match(query(view.container, ".settings-error").textContent, /Cancelled/);
  assert.equal(query(view.container, '[data-setting="general.cli"] button').textContent, "Install");
  await view.unmount();
});

test("computer-use settings refresh permissions", async () => {
  let restarted = false;
  let checks = 0;
  const requested: Array<Parameters<DesktopAPI["enableComputerUse"]>[0]> = [];
  window.desktop = fakeDesktop({
    enableComputerUse: async (permission) => {
      requested.push(permission);
      return { accessibility: false, screenRecording: false };
    },
    computerUsePermissions: async () => item([
      { accessibility: false, screenRecording: false },
      { accessibility: true, screenRecording: true },
    ][checks++]),
    restartForComputerUse: () => { restarted = true; },
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Computer use");
  assert.match(view.container.textContent, /Accessibility/);
  assert.match(view.container.textContent, /Setup required/);
  assert.match(view.container.textContent, /Enable Accessibility/);
  assert.match(view.container.textContent, /Enable Screen Recording/);
  const buttons = query<HTMLElement>(view.container, "[aria-labelledby='permissions-heading']").querySelectorAll<HTMLButtonElement>(".setting-row-action button");
  assert.equal(buttons.length, 2);
  await act(async () => { item(buttons[0]).click(); });
  await act(async () => { item(buttons[1]).click(); });
  assert.deepEqual(requested, ["accessibility", "screenRecording"]);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.match(view.container.textContent, /Setup complete/);
  assert.equal(view.container.querySelectorAll(".setting-row-action em.granted").length, 2);
  assert.match(view.container.textContent, /Done/);
  assert.match(view.container.textContent, /Restart AI Coding Tool/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-restart button").click(); });
  assert.equal(restarted, true);
  await view.unmount();
});

test("Linux computer-use settings show runtime capability without macOS permission controls", async () => {
  window.desktop = fakeDesktop({
    platform: "linux",
    computerUsePermissions: async () => ({
      accessibility: true,
      screenRecording: true,
      linuxRuntime: {
        status: "limited",
        display: "xwayland",
        message: "X11 and XWayland apps are available. Native Wayland apps depend on the compositor and may not be reachable.",
      },
    }),
  });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Computer use");

  assert.match(view.container.textContent, /Linux runtime/);
  assert.match(view.container.textContent, /Compositor-dependent/);
  assert.doesNotMatch(view.container.textContent, /Enable Accessibility|Enable Screen Recording|macOS permissions/);
  await view.unmount();
});

test("computer-use settings stay platform-neutral while Linux capability is loading", async () => {
  window.desktop = fakeDesktop({ platform: "linux", computerUsePermissions: async () => new Promise<never>(() => undefined) });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Computer use");

  assert.match(view.container.textContent, /Platform setup.*Checking what this computer can use/s);
  assert.doesNotMatch(view.container.textContent, /macOS permissions|Enable Accessibility|Enable Screen Recording/);
  await view.unmount();
});

test("the engines page says what is wrong with each engine, and checks again on demand", async () => {
  window.desktop = fakeDesktop({});
  let checks = 0;
  const updates: AgentEngine[] = [];
  const view = await mount(renderSettingsPanel({
    initialSection: "engines",
    engineAccess: {
      claude: { access: "ready", version: "2.1.100", required: "2.1.250", fix: "claude update" },
      codex: { access: "missing", fix: "brew install --cask codex" },
    },
    onRefreshEngines: () => { checks += 1; },
    onUpdateEngine: (engine) => { updates.push(engine); },
  }));
  await act(async () => {});

  const rows = view.container.querySelectorAll<HTMLElement>(".engine-setting-row");
  assert.equal(rows.length, 2);
  assert.match(item(rows[0]).textContent, /Claude 2.1.100 is behind 2.1.250, so some models are hidden./);
  assert.doesNotMatch(item(rows[0]).textContent, /claude update/, "an engine the app can update offers the button rather than the command");
  await act(async () => { query<HTMLButtonElement>(item(rows[0]), ".setting-row-action button").click(); });
  assert.deepEqual(updates, ["claude"]);
  assert.match(item(rows[1]).textContent, /Codex is not installed./);
  assert.match(item(rows[1]).textContent, /brew install --cask codex/);
  assert.match(item(rows[1]).textContent, /Not installed/);
  assert.ok(query(item(rows[1]), ".setting-pill").classList.contains("blocked"), "an engine that cannot run reads apart from one with an update");

  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button").click(); });
  assert.equal(checks, 1, "the button asks the machine again rather than showing what was read at startup");
  await view.unmount();
});

test("an engine that only wants signing in to offers the button rather than a command", async () => {
  window.desktop = fakeDesktop({});
  const signIns: AgentEngine[] = [];
  const view = await mount(renderSettingsPanel({
    initialSection: "engines",
    engineAccess: { claude: { access: "ready", version: "2.1.250" }, codex: { access: "signed-out", version: "0.150.1" } },
    onSignInEngine: (engine) => { signIns.push(engine); },
  }));
  await act(async () => {});

  const rows = view.container.querySelectorAll<HTMLElement>(".engine-setting-row");
  assert.match(item(rows[0]).textContent, /Version 2.1.250/);
  assert.match(item(rows[0]).textContent, /Ready/);
  await act(async () => { query<HTMLButtonElement>(item(rows[1]), ".setting-row-action button").click(); });
  assert.deepEqual(signIns, ["codex"]);
  await view.unmount();
});

test("the usage section draws every provider and reports one that cannot answer", async () => {
  let answer: Record<AgentEngine, PlanUsage> = {
    claude: {
      status: "available",
      subscription: "max",
      windows: [
        { id: "five_hour", label: "Current session", utilization: 17, resetsAt: "2026-08-18T08:19:00Z" },
        { id: "model:Fable", label: "Current week (Fable)", utilization: 96, resetsAt: null },
      ],
    },
    codex: {
      status: "available",
      subscription: "pro",
      windows: [{ id: "codex:primary", label: "Current session", utilization: 23, resetsAt: null }],
    },
  };
  window.desktop = fakeDesktop({ planUsage: async (engine) => answer[engine] });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Usage");

  assert.match(view.container.textContent, /Max plan/);
  assert.match(view.container.textContent, /Pro plan/);
  assert.match(view.container.textContent, /Claude/);
  assert.match(view.container.textContent, /Codex/);
  assert.match(view.container.textContent, /Current session/);
  assert.match(view.container.textContent, /17% used/);
  assert.match(view.container.textContent, /96% used/);
  assert.match(view.container.textContent, /23% used/);
  const fills = view.container.querySelectorAll<HTMLElement>(".usage-window-fill");
  assert.equal(fills.length, 3);
  assert.equal(item(fills[0]).style.width, "17%");
  assert.equal(item(fills[0]).classList.contains("high"), false);
  assert.equal(item(fills[1]).classList.contains("high"), true);

  answer = {
    claude: { status: "unavailable", message: "This build of the Claude SDK does not report plan usage." },
    codex: { status: "not-applicable" },
  };
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button").click(); });
  assert.equal(view.container.querySelectorAll(".usage-window-fill").length, 0);
  assert.match(query(view.container, ".settings-error").textContent, /does not report plan usage/);
  await view.unmount();
});

test("a usage read that rejects reports instead of breaking the panel", async () => {
  window.desktop = fakeDesktop({ planUsage: async () => { throw new Error("Untrusted IPC sender."); } });
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Usage");

  assert.match(query(view.container, ".settings-error").textContent, /Untrusted IPC sender/);
  await view.unmount();
});

test("the appearance page sets the families through its pickers, and the sizes are px the window writes onto the root", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.uiFont, "system");
  assert.equal(root.style.getPropertyValue("--text-content"), "15px");

  const control = (label: string) => query<HTMLButtonElement>(view.container, `button[aria-label="${label}"]`);
  const pick = async (picker: string, name: string) => {
    await act(async () => { query<HTMLButtonElement>(view.container, `button[aria-label^="${picker}:"]`).click(); });
    await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".font-select-list button")].find((option) => option.textContent.includes(name))).click(); });
  };
  assert.ok(control("Interface font: System"), "the font button says which font is in use");
  await pick("Interface font", "Inter");
  assert.equal(root.dataset.uiFont, "inter");
  assert.ok(control("Interface font: Inter"));
  assert.equal(view.container.querySelector(".font-select-popover"), null, "choosing closes the picker");
  await pick("Code and terminal font", "JetBrains Mono");
  assert.equal(root.dataset.monoFont, "jetbrains-mono");

  for (let click = 0; click < 4; click += 1) await act(async () => { control("Larger conversation text size").click(); });
  await act(async () => { control("Smaller terminal text size").click(); });
  assert.equal(root.style.getPropertyValue("--text-content"), "19px");
  assert.equal(root.style.getPropertyValue("--terminal-text"), "11px");

  const stored = JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1")));
  assert.deepEqual(
    { uiFont: stored.uiFont, monoFont: stored.monoFont, readingSize: stored.readingSize, terminalSize: stored.terminalSize },
    { uiFont: "inter", monoFont: "jetbrains-mono", readingSize: 19, terminalSize: 11 },
  );
  await view.unmount();
});

test("a size typed into the field is clamped to the range, and Escape abandons the typing", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Conversation text size"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const type = async (text: string) => {
    await act(async () => { field.focus(); });
    await act(async () => {
      item(setValue).call(field, text);
      field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    });
  };
  const leave = async () => { await act(async () => { field.blur(); }); };

  await type("40");
  await leave();
  assert.equal(root.style.getPropertyValue("--text-content"), "24px", "a typed size lands on the nearest px the range allows");
  assert.equal(field.value, "24", "the field settles on the size that was kept");

  await type("13");
  await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(root.style.getPropertyValue("--text-content"), "24px", "Escape keeps the settled size");
  assert.equal(JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1"))).readingSize, 24);
  await view.unmount();
});

test("a size stored as a rung the app used to offer reopens at the px that rung drew at", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.view-preferences.v1", JSON.stringify({ readingSize: "larger", terminalSize: "small" }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  const root = dom.window.document.documentElement;
  assert.equal(root.style.getPropertyValue("--text-content"), "19px");
  assert.equal(root.style.getPropertyValue("--terminal-text"), "11px");
  await view.unmount();
});

test("the appearance page picks a theme and a ground separately, and each click paints the window", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.theme, "aicodingtool-dark");

  const card = (family: string) => item([...view.container.querySelectorAll<HTMLButtonElement>(".theme-choice")].find((choice) => choice.textContent.includes(family)));
  /** The tiles live in a popover, so the row is opened before one of them can be picked. */
  await act(async () => { item(view.container.querySelector<HTMLButtonElement>(".theme-select > button")).click(); });
  await act(async () => { card("Gruvbox").click(); });
  assert.equal(root.dataset.theme, "gruvbox-dark");

  /** The ground is the other axis: it moves within the theme rather than replacing it. */
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".segmented button")].find((button) => button.textContent === "Light")).click(); });
  assert.equal(root.dataset.theme, "gruvbox-light");

  const stored = JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1")));
  assert.deepEqual({ theme: stored.theme, themeMode: stored.themeMode }, { theme: "gruvbox-light", themeMode: "light" });
  await view.unmount();
});

test("computer-use setup events open settings directly", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;

  await act(async () => {
    item(setValue).call(textarea, "Use the Calculator app");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Use the Calculator app" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').click(); });
  const start = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "computer-use.setup-required", taskId: start.taskId, runId: start.runId, sequence: 1 });
  });
  await settleUntil(() => Boolean(view.container.querySelector(".settings-view")));

  assert.ok(view.container.querySelector(".settings-view"));
  assert.equal(view.container.querySelector(".computer-use-card"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-back").click(); });
  assert.equal(view.container.querySelector(".settings-view"), null);
  await view.unmount();
});

test("an unavailable desktop shortcut is explained in Settings without a startup error", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const message = "Global active-window capture is unavailable in this Wayland session. Use an X11 session.";

  await act(async () => {
    desktop.refuseShortcut({ binding: "Alt+Shift+S", reason: "unsupported", message });
  });

  assert.equal(view.container.querySelector(".storage-error"), null);
  await openSettingsPage(view, "Shortcuts");
  const capture = item([...view.container.querySelectorAll<HTMLElement>(".shortcut-row")]
    .find((row) => query(row, "strong").textContent === "Grab the window you are in"));
  assert.match(query(capture, ".shortcut-unavailable").textContent, /Wayland session.*X11 session/);
  await act(async () => {
    item([...capture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Clear")).click();
  });
  assert.equal(capture.querySelector(".shortcut-unavailable"), null, "clearing the affected binding clears its inline status");
  await view.unmount();
});

test("a desktop shortcut owned by another app remains an actionable error", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => {
    desktop.refuseShortcut({ binding: "Alt+Shift+S", reason: "taken" });
  });

  assert.match(query(view.container, ".storage-error").textContent, /Alt\+Shift\+S belongs to another app/);
  await view.unmount();
});

test("settings rebind a shortcut, and the window is told what to match", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  assert.deepEqual(desktop.shortcuts, [{}], "the window starts out matching the defaults");

  await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-settings").click(); });
  await settleUntil(() => Boolean(view.container.querySelector(".settings-sidebar")), "settings never opened");
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Shortcuts")).click(); });
  const row = (label: string) => item([...view.container.querySelectorAll<HTMLElement>(".shortcut-row")].find((element) => query(element, "strong").textContent === label));
  const keys = (label: string) => [...query(row(label), "kbd").querySelectorAll(".shortcut-key")].map((key) => key.textContent);
  /** jsdom is no Mac, so the panel spells its modifiers out rather than drawing them. */
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "A"]);

  const buttons = (label: string) => [...row(label).querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent);
  assert.deepEqual(buttons("Allow"), ["Change", "Clear"]);
  await act(async () => { item([...row("Allow").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")).click(); });
  assert.match(row("Allow").textContent, /Press a keystroke…/);
  assert.equal(row("Allow").classList.contains("capturing"), true);
  assert.equal(document.activeElement?.textContent, "Cancel", "the focus follows to Cancel so Escape and Tab stay in the row");
  assert.deepEqual(desktop.captures, [true]);

  await act(async () => { desktop.captureShortcut("Mod+Shift+K"); });
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "K"]);
  assert.equal(row("Allow").classList.contains("capturing"), false);
  assert.equal(document.activeElement?.textContent, "Change", "the focus returns to the button that started the capture");
  assert.deepEqual(buttons("Allow"), ["Reset", "Change", "Clear"], "a changed shortcut can still be cleared in one press");
  assert.deepEqual(desktop.captures, [true, false], "the window goes back to acting on keystrokes");
  assert.deepEqual(item(desktop.shortcuts.at(-1)), { "run.allow": "Mod+Shift+K" });

  /** Taking a keystroke that another action holds leaves that action with none. */
  await act(async () => { item([...row("Deny").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")).click(); });
  await act(async () => { desktop.captureShortcut("Mod+Shift+K"); });
  assert.deepEqual(keys("Deny"), ["Ctrl", "Shift", "K"]);
  assert.match(row("Allow").textContent, /Not set/);
  assert.deepEqual(item(desktop.shortcuts.at(-1)), { "run.allow": null, "run.deny": "Mod+Shift+K" });

  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button").click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button.danger").click(); });
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "A"]);
  assert.deepEqual(item(desktop.shortcuts.at(-1)), {});

  await view.unmount();
});

const capabilitySwitch = (root: ParentNode, section: string) =>
  query<HTMLButtonElement>(root, `[aria-labelledby='${section}-heading'] .setting-row-action button`);

test("each capability page carries a switch that turns the whole capability off", async () => {
  const changed: Array<[string, boolean]> = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "computer-use",
    onSetComputerUse: (enabled) => changed.push(["computer-use", enabled]),
    onSetBrowserTools: (enabled) => changed.push(["browser-tools", enabled]),
  }));
  await act(async () => {});

  assert.equal(capabilitySwitch(view.container, "computer-use-availability").getAttribute("aria-checked"), "true");
  await act(async () => { capabilitySwitch(view.container, "computer-use-availability").click(); });

  const browserTab = item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Browser"));
  await act(async () => { browserTab.click(); });
  assert.equal(capabilitySwitch(view.container, "browser-availability").getAttribute("aria-checked"), "true");
  await act(async () => { capabilitySwitch(view.container, "browser-availability").click(); });

  assert.deepEqual(changed, [["computer-use", false], ["browser-tools", false]]);
  await view.unmount();
});

test("the settings only Claude reads are grouped under Claude's own name", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});
  const group = view.container.querySelector("[aria-labelledby='claude-heading']");
  assert.ok(group);
  assert.equal(group.querySelector("#claude-heading")?.textContent, "Claude");
  assert.match(group.textContent ?? "", /Claude in Chrome/);
  await view.unmount();
});

test("a control the jump panel named is marked, until the user opens another page", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", initialSetting: "appearance.mono-font" }));
  await act(async () => {});
  const marked = () => [...view.container.querySelectorAll<HTMLElement>(".setting-row.found")].map((row) => row.dataset.setting);
  assert.deepEqual(marked(), ["appearance.mono-font"]);

  const generalTab = item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "General"));
  await act(async () => { generalTab.click(); });
  const appearanceTab = item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Appearance"));
  await act(async () => { appearanceTab.click(); });
  assert.deepEqual(marked(), [], "the mark is spent once the user has moved on");
  await view.unmount();
});

test("a switch that is off says so and offers to turn it back on", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "computer-use", computerUse: false }));
  await act(async () => {});
  assert.equal(capabilitySwitch(view.container, "computer-use-availability").getAttribute("aria-checked"), "false");
  assert.equal(capabilitySwitch(view.container, "computer-use-availability").getAttribute("aria-label"), "Computer use");
  await view.unmount();
});

test("Engines offers a reload and shows when it is waiting or complete", async () => {
  window.desktop = fakeDesktop({});
  let reloads = 0;
  for (const status of ["idle", "reloading", "pending", "reloaded", "failed"] as const) {
    const view = await mount(renderSettingsPanel({ initialSection: "engines", agentSettingsReload: status, onReloadAgentSettings: () => { reloads++; } }));
    const section = query<HTMLElement>(view.container, '[aria-labelledby="agent-settings-heading"]');
    const button = query<HTMLButtonElement>(section, "button");
    assert.equal(button.textContent, status === "reloading" ? "Reloading…" : "Reload agent settings");
    assert.equal(button.disabled, status === "reloading" || status === "pending");
    assert.equal(button.getAttribute("aria-busy"), String(status === "reloading"), "only the reload in flight reads as busy rather than unavailable");
    if (status === "pending") assert.match(section.textContent, /Reload pending/);
    if (status === "reloaded") assert.match(section.textContent, /Settings reloaded/);
    await act(async () => { button.click(); });
    await view.unmount();
  }
  assert.equal(reloads, 3);
});

test("every on/off setting is a switch named after its row", async () => {
  const changed: Array<[string, boolean]> = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    notifications: true, chromeBrowser: false,
    onSetNotifications: (enabled) => changed.push(["notifications", enabled]), onSetChromeBrowser: (enabled) => changed.push(["chrome", enabled]),
  }));
  await act(async () => {});
  const switches = [...view.container.querySelectorAll<HTMLButtonElement>("[role='switch']")];
  assert.deepEqual(switches.map((control) => [control.getAttribute("aria-label"), control.getAttribute("aria-checked")]), [["Desktop notifications", "true"], ["Claude in Chrome", "false"]]);
  await act(async () => { item(switches[0]).click(); });
  await act(async () => { item(switches[1]).click(); });
  assert.deepEqual(changed, [["notifications", false], ["chrome", true]]);
  await view.unmount();
});

test("Restore defaults asks first, and Esc takes the question back", async () => {
  const shortcuts = shortcutSettings({ "project.start": "Mod+Shift+O" });
  let resets = 0;
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "shortcuts", shortcuts, onResetShortcuts: () => { resets++; } }));
  await act(async () => {});
  const actions = () => query<HTMLElement>(view.container, ".settings-group-action");
  const named = (name: string) => item([...actions().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name));

  assert.ok(named("Restore defaults").closest(".settings-page-heading"), "it sits over every group, not in the first one");
  assert.equal(actions().querySelector("span")?.textContent, "1 changed");
  await act(async () => { named("Restore defaults").click(); });
  assert.equal(resets, 0);
  assert.equal(dom.window.document.activeElement, named("Cancel"));
  await act(async () => { named("Cancel").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(resets, 0);
  assert.equal(dom.window.document.activeElement, named("Restore defaults"), "the focus goes back to the button that asked");

  await act(async () => { named("Restore defaults").click(); });
  await act(async () => { named("Restore all").click(); });
  assert.equal(resets, 1);
  await view.unmount();
});

test("a shortcut row always offers Clear, and Reset beside it once it is changed", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "shortcuts", shortcuts: shortcutSettings({ "project.start": "Mod+Shift+O" }) }));
  await act(async () => {});
  const rows = [...view.container.querySelectorAll<HTMLElement>(".shortcut-row")];
  const labels = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>(".setting-row-action button")].map((button) => button.textContent);
  assert.deepEqual(labels(item(rows.find((row) => row.dataset.setting !== "shortcut.project.start" && row.querySelector(".shortcut-keys")))), ["Change", "Clear"]);
  assert.deepEqual(labels(query<HTMLElement>(view.container, ".shortcut-row[data-setting='shortcut.project.start']")), ["Reset", "Change", "Clear"]);
  await view.unmount();
});

test("the appearance pickers walk by arrow keys and hand the focus back to their button", async () => {
  const chosen: string[] = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", onSetUiFont: (font) => chosen.push(font), onSetThemeFamily: (family) => chosen.push(family) }));
  await act(async () => {});
  const document = dom.window.document;
  const key = async (target: Element, name: string) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true })); }); };

  const fontButton = query<HTMLButtonElement>(view.container, 'button[aria-label^="Interface font:"]');
  await act(async () => { fontButton.click(); });
  const search = query<HTMLInputElement>(view.container, ".font-select-popover input");
  assert.equal(document.activeElement, search);
  await key(search, "ArrowDown");
  const options = [...view.container.querySelectorAll<HTMLButtonElement>(".font-select-list button")];
  assert.equal(document.activeElement, options[0]);
  await key(item(options[0]), "ArrowDown");
  assert.equal(document.activeElement, options[1]);
  await act(async () => { item(options[1]).click(); });
  assert.equal(chosen.length, 1);
  assert.equal(document.activeElement, fontButton, "a pick hands the focus back to the picker's button");

  const themeButton = query<HTMLButtonElement>(view.container, ".theme-select > button");
  assert.equal(themeButton.getAttribute("aria-label"), `Theme: ${themeButton.textContent}`, "the theme button says which theme is in use");
  await act(async () => { themeButton.click(); });
  await key(query(view.container, ".theme-select-popover input"), "Escape");
  assert.equal(view.container.querySelector(".theme-select-popover"), null);
  assert.equal(document.activeElement, themeButton, "Esc hands the focus back too");
  await key(themeButton, "ArrowDown");
  assert.ok(view.container.querySelector(".theme-select-popover"), "ArrowDown on the button opens the themes");
  assert.equal(document.activeElement, query(view.container, ".theme-select-popover input"));
  await view.unmount();
});

test("arrow keys step a size field the way its buttons do", async () => {
  const sizes: number[] = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", readingSize: 15, onSetReadingSize: (size) => sizes.push(size) }));
  await act(async () => {});
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Conversation text size"]');
  await act(async () => { field.focus(); });
  for (const key of ["ArrowUp", "ArrowUp", "ArrowDown"]) await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
  assert.deepEqual(sizes, [16, 17, 16]);
  assert.equal(field.value, "16");
  await view.unmount();
});

async function typeInto(field: HTMLInputElement, text: string) {
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => { field.focus(); });
  await act(async () => {
    item(setValue).call(field, text);
    field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
}

test("an allowed site can be taken back alone, and clearing everything looks destructive", async () => {
  const forgotten: string[] = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "browser", allowedOrigins: ["https://a.test", "https://b.test"], onForgetOrigin: (origin) => forgotten.push(origin) }));
  await act(async () => {});
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove https://b.test"]').click(); });
  assert.deepEqual(forgotten, ["https://b.test"]);
  const clear = item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-group-action button")].find((button) => button.textContent === "Clear browser data"));
  assert.ok(clear.classList.contains("danger"));
  assert.equal(view.container.querySelector('[data-setting="browser.session"] .setting-status'), null, "a site row carries no step circle");
  await view.unmount();

  const bare = await mount(renderSettingsPanel({ initialSection: "browser", allowedOrigins: ["https://a.test"] }));
  await act(async () => {});
  assert.equal(bare.container.querySelector('button[aria-label="Remove https://a.test"]'), null);
  await bare.unmount();
});

test("a busy settings button reads as busy, while one only waiting its turn does not", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "engines", engineChecking: true }));
  await act(async () => {});
  const check = query<HTMLButtonElement>(view.container, '[data-setting="engines.installed"] .settings-group-action button');
  assert.equal(check.textContent, "Checking…");
  assert.equal(check.getAttribute("aria-busy"), "true");
  await view.unmount();

  const idle = await mount(renderSettingsPanel({ initialSection: "engines", engineChecking: false }));
  await act(async () => {});
  assert.equal(query(idle.container, '[data-setting="engines.installed"] .settings-group-action button').getAttribute("aria-busy"), "false");
  await idle.unmount();
});

test("a theme search marks the tile Enter picks, and arrows walk the tiles", async () => {
  const chosen: string[] = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", onSetThemeFamily: (family) => chosen.push(family) }));
  await act(async () => {});
  const document = dom.window.document;
  const key = async (target: Element, name: string) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };
  const open = async () => {
    await act(async () => { query<HTMLButtonElement>(view.container, ".theme-select > button").click(); });
    return query<HTMLInputElement>(view.container, ".theme-select-popover input");
  };

  let search = await open();
  assert.equal(view.container.querySelector(".theme-choice.next"), null, "nothing is marked before a search");
  await key(search, "Enter");
  assert.deepEqual(chosen, [], "Enter with no search picks nothing");
  await key(search, "ArrowDown");
  assert.equal(document.activeElement, query(view.container, ".theme-choice.chosen"), "Down from the search lands on the theme in use");
  const tiles = [...view.container.querySelectorAll<HTMLButtonElement>(".theme-choice")];
  const stops = () => tiles.filter((tile) => tile.tabIndex === 0);
  assert.deepEqual(stops(), [query(view.container, ".theme-choice.chosen")], "Tab stops on the chosen tile alone");
  const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
  await key(item(tiles[at]), "ArrowRight");
  assert.equal(document.activeElement, tiles[at + 1]);
  assert.deepEqual(stops(), [tiles[at + 1]], "the Tab stop follows the arrows");
  await key(item(tiles[at + 1]), "ArrowLeft");
  assert.equal(document.activeElement, tiles[at]);

  await typeInto(search, "gruv");
  const marked = [...view.container.querySelectorAll(".theme-choice.next")];
  assert.equal(marked.length, 1);
  assert.match(item(marked[0]).textContent, /Gruvbox/);
  await key(search, "Enter");
  assert.deepEqual(chosen, ["Gruvbox"]);

  search = await open();
  await typeInto(search, "zzz");
  assert.equal(view.container.querySelector(".theme-choice.next"), null);
  await view.unmount();
});

test("a font search marks the option Enter picks", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "appearance" }));
  await act(async () => {});
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Interface font:"]').click(); });
  assert.equal(view.container.querySelector(".font-select-list button.next"), null);
  const search = query<HTMLInputElement>(view.container, ".font-select-popover input");
  await typeInto(search, "i");
  const marked = [...view.container.querySelectorAll(".font-select-list button.next")];
  assert.equal(marked.length, 1);
  assert.equal(marked[0], view.container.querySelector(".font-select-list button"));
  await view.unmount();
});
