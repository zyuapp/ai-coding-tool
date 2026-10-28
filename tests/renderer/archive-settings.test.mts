import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { renderSettingsPanel } from "../support/settings-panel.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";

async function typeInto(field: HTMLInputElement, text: string) {
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => { field.focus(); });
  await act(async () => {
    item(setValue).call(field, text);
    field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
}

test("clearing the archive asks first, with the focus on Cancel", async () => {
  let cleared = 0;
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "archive", archivedThreads: [task("Old", { archivedAt: Date.now() })], onClearArchive: () => { cleared++; } }));
  await act(async () => {});
  const named = (name: string) => item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-group-action button")].find((button) => button.textContent === name));
  await act(async () => { named("Clear all").click(); });
  assert.equal(dom.window.document.activeElement, named("Cancel"));
  assert.equal(cleared, 0);
  await act(async () => { named("Delete 1 thread").click(); });
  assert.equal(cleared, 1);
  await view.unmount();
});

test("an archive offers a filter, and a filter that misses offers the way back", async () => {
  window.desktop = fakeDesktop({});
  const threads = Array.from({ length: 9 }, (_, index) => task(`Thread ${index + 1}`, { archivedAt: Date.now() }));
  const view = await mount(renderSettingsPanel({ initialSection: "archive", archivedThreads: [...threads, task("Parser fix", { archivedAt: Date.now() })] }));
  await act(async () => {});
  const titles = () => [...view.container.querySelectorAll(".settings-group .setting-row strong")].map((title) => title.textContent);
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Filter archived threads"]');

  await typeInto(field, "parser");
  assert.deepEqual(titles(), ["Parser fix"]);
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(escape); });
  assert.equal(escape.defaultPrevented, true, "Esc empties the filter before it can close settings");
  assert.equal(titles().length, 10);

  await typeInto(field, "zzz");
  assert.deepEqual(titles(), []);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-empty-action").click(); });
  assert.equal(field.value, "");
  assert.equal(titles().length, 10);
  assert.equal(dom.window.document.activeElement, field);

  const empty = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(empty); });
  assert.equal(empty.defaultPrevented, false, "an empty filter leaves Esc to settings");
  await view.unmount();

  const short = await mount(renderSettingsPanel({ initialSection: "archive", archivedThreads: threads.slice(0, 3) }));
  await act(async () => {});
  assert.equal(short.container.querySelector('input[aria-label="Filter archived threads"]'), null, "a short archive lists its threads without a filter");
  assert.ok(query(short.container, ".settings-group-action button").classList.contains("danger"), "Clear all looks destructive before it is armed");
  await short.unmount();

  const none = await mount(renderSettingsPanel({ initialSection: "archive", archivedThreads: [] }));
  await act(async () => {});
  assert.equal(none.container.querySelector('input[aria-label="Filter archived threads"]'), null);
  await none.unmount();
});

test("each archived thread names its project, and the filter finds threads by it", async () => {
  window.desktop = fakeDesktop({});
  const projects = [{ id: "p1", root: "/work/parser" }, { id: "p2", root: "/work/site", name: "Website" }];
  const filler = Array.from({ length: 8 }, (_, index) => task(`Other ${index + 1}`, { archivedAt: Date.now() }));
  const threads = [task("fix-1", { title: "Fix", archivedAt: Date.now(), projectId: "p1" }), task("fix-2", { title: "Fix", archivedAt: Date.now(), projectId: "p2" }), ...filler];
  const view = await mount(renderSettingsPanel({ initialSection: "archive", archivedThreads: threads, projects }));
  await act(async () => {});
  const lines = () => [...view.container.querySelectorAll(".settings-group .setting-row p")].map((line) => line.textContent);
  assert.match(item(lines()[0]), /^parser · Deletes in \d+ days?$/);
  assert.match(item(lines()[1]), /^Website · /);
  await typeInto(query<HTMLInputElement>(view.container, 'input[aria-label="Filter archived threads"]'), "website");
  assert.equal(lines().length, 1);
  assert.match(item(lines()[0]), /^Website · /);
  await view.unmount();
});
