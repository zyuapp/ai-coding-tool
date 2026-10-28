import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { shortcutSettings } from "../../src/domain/shortcuts.ts";
import { fakeDesktop } from "../support/desktop-api.mts";
import { renderSettingsPanel, type MountView } from "../support/settings-panel.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";

async function searchSettings(view: MountView, text: string) {
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Search settings"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => { field.focus(); });
  await act(async () => {
    item(setValue).call(field, text);
    field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
  return field;
}

const searchResults = (view: MountView) => [...view.container.querySelectorAll<HTMLButtonElement>(".settings-search-results [role='option']")]
  .map((option) => option.textContent);

test("a settings search stands in for the pages, and Enter lands on the control it picked", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});

  const field = await searchSettings(view, "terminal text");
  assert.equal(view.container.querySelector(".settings-sidebar nav"), null, "the pages give way to the results");
  assert.deepEqual(searchResults(view), ["Terminal textAppearance"]);

  await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(field.value, "");
  assert.equal(query(view.container, ".settings-sidebar nav [aria-current='page']").textContent, "Appearance");
  assert.deepEqual([...view.container.querySelectorAll<HTMLElement>(".found")].map((row) => row.dataset.setting), ["appearance.terminal-size"]);
  await view.unmount();
});

test("landing on the same control again flashes it again", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});
  const land = async () => {
    const field = await searchSettings(view, "terminal text");
    await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };

  await land();
  const row = query<HTMLElement>(view.container, "[data-setting='appearance.terminal-size']");
  const changes: (string | null)[] = [];
  const observer = new dom.window.MutationObserver((records) => changes.push(...records.map((record) => record.oldValue)));
  observer.observe(row, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  await land();
  await act(async () => {});
  observer.disconnect();
  assert.ok(changes.some((value) => !value?.split(" ").includes("found")), "the mark is taken off and put back, which restarts the flash");
  assert.ok(row.classList.contains("found"));
  await view.unmount();
});

test("a search lands on a shortcut and on a group, not only on a page", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ shortcuts: shortcutSettings({}) }));
  await act(async () => {});
  const marked = () => [...view.container.querySelectorAll<HTMLElement>(".found")].map((row) => row.dataset.setting);

  await searchSettings(view, "deny");
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-search-results [role='option']")][0]).click(); });
  assert.deepEqual(marked(), ["shortcut.run.deny"]);

  await searchSettings(view, "agent settings");
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-search-results [role='option']")][0]).click(); });
  assert.equal(query(view.container, ".settings-sidebar nav [aria-current='page']").textContent, "Engines");
  assert.deepEqual(marked(), ["engines.agent-settings"]);
  await view.unmount();
});

test("Escape empties a settings search before it can close settings, and a miss says so", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});

  const field = await searchSettings(view, "zzz");
  assert.match(query(view.container, ".settings-search-empty").textContent, /^No settings match/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-search-empty button").click(); });
  assert.equal(field.value, "", "the miss offers the way back to the pages");
  assert.ok(view.container.querySelector(".settings-sidebar nav"));
  await searchSettings(view, "zzz");

  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(escape); });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(field.value, "");
  assert.ok(view.container.querySelector(".settings-sidebar nav"));

  const again = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(again); });
  assert.equal(again.defaultPrevented, false, "an empty search leaves Escape to close settings");
  await view.unmount();
});

test("a settings result shows in bold the part of its name the search typed", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({}));
  await act(async () => {});
  await searchSettings(view, "notif");
  const marks = [...view.container.querySelectorAll(".settings-search-results mark")].map((mark) => mark.textContent?.toLowerCase());
  assert.ok(marks.length > 0);
  assert.ok(marks.every((mark) => mark === "notif"));
  await view.unmount();
});
