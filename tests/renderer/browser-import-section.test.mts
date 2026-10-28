import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { BrowserImportSection, NO_BROWSER_IMPORT_SETTINGS, type BrowserImportSettings } from "../../src/renderer/components/BrowserImportSection.tsx";
import { NO_BROWSER_IMPORT, type BrowserImportPicker } from "../../src/application/browser-import.ts";

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
