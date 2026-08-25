import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel, type SettingsPanelProps } from "../src/renderer/components/SettingsPanel.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** jsdom lays nothing out, so a frame is only ever the next turn of the loop. */
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });

afterAll(() => { dom.window.close(); });

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { container, async unmount() { await act(async () => { root.unmount(); }); container.remove(); } };
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

function panel(overrides: Partial<SettingsPanelProps>) {
  window.desktop = { computerUsePermissions: async () => ({ accessibility: true, screenRecording: true }) } as unknown as typeof window.desktop;
  return React.createElement(SettingsPanel, {
    onClose() {},
    archivedTasks: [], managedWorktrees: [], worktreeManagementError: null, worktreeManagementNotice: null,
    theme: "aicodingtool-dark", themeMode: "auto", uiFont: "system", monoFont: "system", readingSize: 15, terminalSize: 13,
    allowedOrigins: [],
    plainEnglish: false, chromeBrowser: false, computerUse: true, browserTools: true, notifications: true,
    shortcuts: [], capturingShortcut: null,
    onSetThemeFamily() {}, onSetThemeMode() {}, onSetUiFont() {}, onSetMonoFont() {}, onSetReadingSize() {}, onSetTerminalSize() {},
    onSetPlainEnglish() {}, onSetChromeBrowser() {}, onSetComputerUse() {}, onSetBrowserTools() {}, onSetNotifications() {},
    onRestoreTask() {}, onClearArchive() {}, onRefreshWorktrees() {}, onRevealWorktree() {}, onDeleteWorktree() {},
    onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {},
    ...overrides,
  });
}

const toggle = (root: ParentNode, section: string) => query<HTMLButtonElement>(root, `[aria-labelledby='${section}-heading'] .setting-row-action button`);

test("each capability page carries a switch that turns the whole capability off", async () => {
  const changed: Array<[string, boolean]> = [];
  const view = await mount(panel({
    initialSection: "computer-use",
    onSetComputerUse: (enabled) => changed.push(["computer-use", enabled]),
    onSetBrowserTools: (enabled) => changed.push(["browser-tools", enabled]),
  }));
  await act(async () => {});

  assert.equal(toggle(view.container, "computer-use").getAttribute("aria-checked"), "true");
  await act(async () => { toggle(view.container, "computer-use").click(); });

  const browserTab = [...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Browser");
  assert.ok(browserTab);
  await act(async () => { browserTab.click(); });
  assert.equal(toggle(view.container, "browser-tools").getAttribute("aria-checked"), "true");
  await act(async () => { toggle(view.container, "browser-tools").click(); });

  assert.deepEqual(changed, [["computer-use", false], ["browser-tools", false]]);
  await view.unmount();
});

test("a switch that is off says so and offers to turn it back on", async () => {
  const view = await mount(panel({ initialSection: "computer-use", computerUse: false }));
  await act(async () => {});
  assert.equal(toggle(view.container, "computer-use").getAttribute("aria-checked"), "false");
  assert.equal(toggle(view.container, "computer-use").textContent, "Turn on");
  await view.unmount();
});
