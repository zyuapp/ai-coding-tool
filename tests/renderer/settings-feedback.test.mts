import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { fakeDesktop } from "../support/desktop-api.mts";
import { renderSettingsPanel } from "../support/settings-panel.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { ComputerSettings } from "../../src/renderer/components/ComputerSettings.tsx";
import type { Thread } from "../../src/domain/thread.ts";

const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;

async function type(field: HTMLInputElement, text: string) {
  await act(async () => { field.focus(); });
  await act(async () => {
    item(setValue).call(field, text);
    field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
}

const key = (target: Element, name: string) => {
  const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

function Archive({ initial }: { initial: Thread[] }) {
  const [threads, setThreads] = React.useState(initial);
  return renderSettingsPanel({ initialSection: "archive", archivedThreads: threads, onRestoreThread: (id) => setThreads((all) => all.filter((thread) => thread.id !== id)) });
}

test("restoring a thread names it, says where it went, and hands the keyboard to the next row", async () => {
  window.desktop = fakeDesktop({});
  const threads = [task("Parser fix", { archivedAt: Date.now() }), task("Docs pass", { archivedAt: Date.now() })];
  const view = await mount(React.createElement(Archive, { initial: threads }));
  await act(async () => {});
  const restore = query<HTMLButtonElement>(view.container, 'button[aria-label="Restore Parser fix"]');
  await act(async () => { restore.focus(); restore.click(); });
  assert.equal(query(view.container, "[role='status'].settings-status").textContent, "Restored “Parser fix” to the sidebar");
  assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Restore Docs pass");
  await view.unmount();
});

function Sites({ initial }: { initial: string[] }) {
  const [origins, setOrigins] = React.useState(initial);
  return renderSettingsPanel({ initialSection: "browser", allowedOrigins: origins, onForgetOrigin: (origin) => setOrigins((all) => all.filter((each) => each !== origin)) });
}

test("removing an allowed site keeps the keyboard in the list", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(React.createElement(Sites, { initial: ["https://a.test", "https://b.test"] }));
  await act(async () => {});
  const remove = query<HTMLButtonElement>(view.container, 'button[aria-label="Remove https://b.test"]');
  await act(async () => { remove.focus(); remove.click(); });
  assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Remove https://a.test");
  assert.equal(query(view.container, "[role='status'].settings-status").textContent, "Removed https://b.test");
  await view.unmount();
});

test("a failed reload says why, and engine buttons name their engine", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "engines",
    agentSettingsReload: "failed",
    agentSettingsReloadError: "Worker unavailable",
    engineAccess: { claude: { access: "signed-out" }, codex: { access: "ready", version: "1.0.0", required: "1.2.0" } },
  }));
  await act(async () => {});
  assert.equal(query(view.container, ".settings-status.failed").textContent, "Could not reload settings: Worker unavailable");
  assert.ok(view.container.querySelector('button[aria-label="Sign in to Claude"]'));
  assert.equal(query(view.container, ".setting-pill").textContent, "Needs update");
  await view.unmount();
});

test("a typed size out of range is clamped and the range stays in view", async () => {
  window.desktop = fakeDesktop({});
  const sizes: number[] = [];
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", onSetReadingSize: (size) => sizes.push(size) }));
  await act(async () => {});
  const row = query<HTMLElement>(view.container, '[data-setting="appearance.reading-size"]');
  const range = () => query(row, ".size-range");
  assert.match(range().textContent, /^\d+–\d+ px$/, "the range shows at rest");
  const field = query<HTMLInputElement>(row, "input");
  await type(field, "99");
  await act(async () => { field.blur(); });
  assert.ok(sizes.length === 1 && sizes[0]! < 99);
  assert.ok(range().classList.contains("clamped"));
  assert.match(range().textContent, /^Max \d+ px$/);
  await view.unmount();
});

test("Light, Dark and Auto are one stop that Left and Right choose along", async () => {
  window.desktop = fakeDesktop({});
  const modes: string[] = [];
  const view = await mount(renderSettingsPanel({ initialSection: "appearance", onSetThemeMode: (mode) => modes.push(mode) }));
  await act(async () => {});
  const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".segmented [role=radio]")];
  assert.equal(buttons.filter((button) => button.tabIndex === 0).length, 1);
  assert.equal(buttons.find((button) => button.tabIndex === 0)?.getAttribute("aria-checked"), "true");
  await act(async () => { buttons[0]!.focus(); });
  await act(async () => { key(buttons[0]!, "ArrowRight"); });
  assert.equal(dom.window.document.activeElement, buttons[1]);
  await act(async () => { key(buttons[1]!, "ArrowLeft"); key(buttons[0]!, "ArrowLeft"); });
  assert.equal(dom.window.document.activeElement, buttons[buttons.length - 1]);
  assert.deepEqual(modes, ["dark", "light", "auto"]);
  await view.unmount();
});

test("a search that lands on a control hands it the keyboard", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Search settings"]');
  await type(field, "terminal text");
  await act(async () => { key(field, "Enter"); });
  await act(async () => {});
  const row = query(view.container, "[data-setting='appearance.terminal-size']");
  assert.ok(row.contains(dom.window.document.activeElement));
  await view.unmount();
});

test("an emptied computer name says it went back to the machine's, and Escape reverts only an edit", async () => {
  const renames: string[] = [];
  const view = await mount(React.createElement(ComputerSettings, {
    found: [], searching: false, searchError: null, name: "studio", links: [], pairing: null,
    onDiscover() {}, onPair() {}, onCancelPairing() {}, onForget() {}, onReconnect() {}, onRename: (name) => renames.push(name), onLabel() {},
  }));
  try {
    const field = query<HTMLInputElement>(view.container, ".computer-name input");
    assert.equal(key(field, "Escape").defaultPrevented, false, "an untouched field lets Escape leave settings");
    await type(field, "draft");
    let escape!: Event;
    await act(async () => { escape = key(field, "Escape"); });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(field.value, "studio");
    await type(field, "  ");
    await act(async () => { field.blur(); });
    assert.deepEqual(renames, [""]);
    assert.equal(query(view.container, ".computer-name-saved").textContent, "Back to the machine's own name");
  } finally {
    await view.unmount();
  }
});
