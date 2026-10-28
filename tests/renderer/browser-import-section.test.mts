import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { BrowserImportSection, NO_BROWSER_IMPORT_SETTINGS, type BrowserImportSettings } from "../../src/renderer/components/BrowserImportSection.tsx";
import { NO_BROWSER_IMPORT, type BrowserImportPicker } from "../../src/application/browser-import.ts";
import { MAX_IMPORT_SITES } from "../../src/domain/browser-import.ts";

const SOURCE = { id: "chrome-default", browser: "Chrome", profile: "Default" };

function settings(picker: BrowserImportPicker | null, calls: string[]): BrowserImportSettings {
  return {
    ...NO_BROWSER_IMPORT_SETTINGS,
    state: { ...NO_BROWSER_IMPORT, sources: [SOURCE], picker },
    onChoose: (sourceId) => calls.push(`choose:${sourceId}`),
    onFilter: (text) => calls.push(`filter:${text}`),
  };
}

const picker = (filter: string): BrowserImportPicker => ({ sourceId: SOURCE.id, sites: [{ domain: "github.com", cookies: 4 }], selected: [], filter });

function escape() {
  const event = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => void query(document, ".browser-import-picker input[type='search']").dispatchEvent(event));
  return event;
}

test("Escape in the site picker empties the search, then closes the picker and returns the focus to Choose sites", async () => {
  const calls: string[] = [];
  const view = await mount(React.createElement(BrowserImportSection, { settings: settings(picker("git"), calls) }));
  try {
    assert.equal(escape().defaultPrevented, true, "the settings sheet stays open");
    assert.deepEqual(calls, ["filter:"]);

    await view.render(React.createElement(BrowserImportSection, { settings: settings(picker(""), calls) }));
    escape();
    assert.deepEqual(calls, ["filter:", "choose:null"]);

    await view.render(React.createElement(BrowserImportSection, { settings: settings(null, calls) }));
    assert.equal(document.activeElement?.textContent, "Choose sites");
  } finally { await view.unmount(); }
});

test("All sites ticks every matching site in one go, and clears them once all are ticked", async () => {
  const calls: string[] = [];
  const sites = [{ domain: "github.com", cookies: 4 }, { domain: "gitlab.com", cookies: 2 }, { domain: "example.com", cookies: 1 }];
  const state = (selected: string[], filter: string): BrowserImportSettings => ({
    ...settings({ sourceId: SOURCE.id, sites, selected, filter }, calls),
    onToggle: (site) => calls.push(`toggle:${site}`),
  });
  const every = () => query<HTMLInputElement>(document, ".browser-import-every input");
  const view = await mount(React.createElement(BrowserImportSection, { settings: state(["gitlab.com"], "git") }));
  try {
    assert.match(query(document, ".browser-import-every").textContent!, /All matching1 of 2/);
    assert.equal(every().indeterminate, true);
    act(() => every().click());
    assert.deepEqual(calls, ["toggle:github.com"], "only the matching site still unticked changes");

    calls.length = 0;
    await view.render(React.createElement(BrowserImportSection, { settings: state(["github.com", "gitlab.com"], "git") }));
    assert.equal(every().checked, true);
    act(() => every().click());
    assert.deepEqual(calls, ["toggle:github.com", "toggle:gitlab.com"]);

    await view.render(React.createElement(BrowserImportSection, { settings: state([], "github") }));
    assert.equal(document.querySelector(".browser-import-every"), null, "a single match has its own box");
  } finally { await view.unmount(); }
});

test("At the site limit the picker says so and the unticked sites cannot be ticked", async () => {
  const calls: string[] = [];
  const sites = Array.from({ length: MAX_IMPORT_SITES + 1 }, (_, index) => ({ domain: `site${index}.com`, cookies: 1 }));
  const last = `site${MAX_IMPORT_SITES}.com`;
  const state = (selected: string[], filter = ""): BrowserImportSettings => settings({ sourceId: SOURCE.id, sites, selected, filter }, calls);
  const limit = () => document.querySelector(".browser-import-limit");
  const box = (domain: string) => [...document.querySelectorAll<HTMLLabelElement>(".browser-import-sites label")]
    .find((label) => label.querySelector("span")?.textContent === domain)!.querySelector("input")!;
  const view = await mount(React.createElement(BrowserImportSection, { settings: state(sites.slice(1, MAX_IMPORT_SITES).map((site) => site.domain)) }));
  try {
    assert.equal(limit(), null);
    assert.equal(box("site0.com").disabled, false);

    const full = sites.slice(0, MAX_IMPORT_SITES).map((site) => site.domain);
    await view.render(React.createElement(BrowserImportSection, { settings: state(full) }));
    assert.equal(limit()?.textContent, `Limit reached: ${MAX_IMPORT_SITES} of ${MAX_IMPORT_SITES} sites`);
    assert.equal(box("site0.com").disabled, false, "a ticked site can still be cleared");

    await view.render(React.createElement(BrowserImportSection, { settings: state(full, last) }));
    assert.equal(box(last).disabled, true);
  } finally { await view.unmount(); }
});
