import { seedTaskWithSubagent } from "../support/subagents.mts";
import { mountWorkspace } from "../support/workspace-renderer.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { ThreadResponse } from "../../src/contracts/threads.ts";

import { dom, item, mount, place, placed, query } from "../support/renderer-dom.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");
const { ImageAnnotator } = await import("../../src/renderer/components/ImageAnnotator.tsx");

function callNamed(calls: unknown[][], name: string): unknown[] {
  return item(calls.find((call) => call[0] === name));
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") assert.fail("Expected a string");
  return value;
}

type BrowserReadResult = import("../../src/contracts/threads.ts").BrowserReadResult;

function responseResult(response: ThreadResponse | undefined): unknown {
  const actual = item(response);
  if (!actual.ok) assert.fail(actual.message);
  return actual.result;
}

function responseRecord(response: ThreadResponse | undefined): Record<string, unknown> {
  const result = responseResult(response);
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function browserReadResult(response: ThreadResponse | undefined): BrowserReadResult {
  const result = responseRecord(response);
  assert.ok(["tabs", "snapshot", "shot", "console", "network", "wait", "awaiting-approval", "no-tab"].includes(String(result.kind)));
  return result as BrowserReadResult;
}

test("the browser panel drives the page through the workspace and reports where it is drawn", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const address = query<HTMLInputElement>(view.container, '.browser-bar input[aria-label="Address"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(address, "example.com/docs");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com/docs" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

  const opened = callNamed(desktop.browserCalls, "open");
  const tabId = stringValue(opened[1]);
  assert.deepEqual(callNamed(desktop.browserCalls, "navigate"), ["navigate", tabId, "https://example.com/docs"], "the blank tab the launcher made is the one that loads");
  assert.deepEqual(callNamed(desktop.browserCalls, "show").slice(0, 1), ["show"]);
  assert.ok(desktop.browserCalls.some((call) => call[0] === "bounds"), "the panel reports its rectangle to main");

  await act(async () => {
    desktop.browserEvent({ tabId, url: "https://example.com/docs", title: "Docs", loading: false, canGoBack: true });
  });
  assert.match(query(view.container, ".right-dock-tab.active").textContent, /Docs/, "a page names its own dock tab");

  await act(async () => { query<HTMLButtonElement>(view.container, '.browser-bar button[aria-label="Back"]').click(); });
  assert.deepEqual(desktop.browserCalls.at(-1), ["history", tabId, -1]);

  await view.unmount();
  assert.deepEqual(desktop.browserCalls.at(-1), ["bounds", null], "an unmounted panel leaves no page drawn over the app");
});

test("anything the document draws over the page takes it off screen", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const drawn = () => desktop.browserCalls.at(-1);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const box = place(".browser-viewport", { x: 0, y: 50, width: 400, height: 600 });
  place('.right-dock-add div[role="menu"]', { x: 0, y: 0, width: 400, height: 200 });
  place(".annotator", { x: 0, y: 0, width: 1200, height: 800 });
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "an uncovered panel draws the page where it is");

  const add = query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", null], "the page is not drawn while the menu hangs over it");
  await act(async () => { add.click(); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "closing the menu draws the page again");

  /** A modal opened somewhere else entirely, which nothing here was told about. */
  const modal = await mount(React.createElement(ImageAnnotator, { source: "data:image/png;base64,x", annotations: [], onCancel: () => {}, onApply: () => {} }));
  await settle();
  assert.deepEqual(drawn(), ["bounds", null], "a modal covers the page without the panel naming it");
  await modal.unmount();
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "closing the modal draws the page again");

  await view.unmount();
  placed.length = 0;
});

test("⌘W closes the page in front, then the dock, and only then the window", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const address = query<HTMLInputElement>(view.container, '.browser-bar input[aria-label="Address"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(address, "example.com");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 1);

  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, "the page is the tab, so it goes first");
  assert.equal(view.container.querySelector(".browser-panel"), null);

  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.equal(query<HTMLElement>(view.container, ".right-dock").hidden, true, "then the dock");

  assert.deepEqual(desktop.browserCalls.filter((call) => call[0] === "close-window"), []);
  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.deepEqual(desktop.browserCalls.filter((call) => call[0] === "close-window"), [["close-window"]], "with nothing in front, ⌘W is the window's");

  await view.unmount();
});

test("a run reads the page through the window and is told when a site is waiting on the user", async () => {
  const inspections: unknown[][] = [];
  const desktop = fakeDesktop({ inspectBrowserPage: async (tabId, inspection) => {
    inspections.push([tabId, inspection]);
    return inspection.op === "console" ? { kind: "console", tabId, url: "https://example.com/", title: "Example", entries: [], latestSequence: 0, omitted: 0 } : null;
  } });
  const harness = await mountWorkspace(desktop);

  await act(async () => { await harness.get().dispatch({ type: "view.set-prompt", prompt: "look at the dashboard" }); });
  await act(async () => { await harness.get().dispatch({ type: "task.send" }); });
  const taskId = item(harness.get().currentThread).id;
  await act(async () => { await harness.get().dispatch({ type: "browser.open", url: "https://example.com" }); });
  const tabId = item(harness.get().browserTabs[0]).id;

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-1", taskId, op: "browser", read: { op: "tabs" } }); });
  const tabs = browserReadResult(desktop.threadAnswers.at(-1));
  if (tabs.kind !== "tabs") assert.fail("Expected the browser tab list");
  assert.deepEqual(tabs.tabs.map((tab) => tab.id), [tabId]);

  /** A page belongs to the thread whose dock holds it, so no other thread reads it. */
  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-2", taskId: "elsewhere", op: "browser", read: { op: "tabs" } }); });
  const elsewhere = browserReadResult(desktop.threadAnswers.at(-1));
  if (elsewhere.kind !== "tabs") assert.fail("Expected the browser tab list");
  assert.deepEqual(elsewhere.tabs, []);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-3", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 5_000, textLimit: 500 } });
  });
  assert.deepEqual(desktop.browserCalls.at(-1), ["read", tabId, 500, 5_000]);
  const snapshot = browserReadResult(desktop.threadAnswers.at(-1));
  if (snapshot.kind !== "snapshot") assert.fail("Expected a browser snapshot");
  assert.equal(snapshot.snapshot.title, "Example");

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "console-1", taskId, op: "browser", read: { op: "console", since: 3 } });
  });
  assert.deepEqual(inspections.at(-1), [tabId, { op: "console", since: 3 }]);
  assert.equal(browserReadResult(desktop.threadAnswers.at(-1)).kind, "console");

  /** A run asking for a site nobody has allowed is answered with the ask, not with a page. */
  await act(async () => { await harness.get().dispatch({ type: "browser.open", taskId, url: "https://dash.example.com" }); });
  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-4", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 1_000 } });
  });
  assert.deepEqual(browserReadResult(desktop.threadAnswers.at(-1)), { kind: "awaiting-approval", url: "https://dash.example.com/" });

  await harness.view.unmount();
});

test("a run captures a tab and is answered with the file the picture went to", async () => {
  const desktop = fakeDesktop();
  const harness = await mountWorkspace(desktop);

  await act(async () => { await harness.get().dispatch({ type: "view.set-prompt", prompt: "check the header" }); });
  await act(async () => { await harness.get().dispatch({ type: "task.send" }); });
  const taskId = item(harness.get().currentThread).id;
  await act(async () => { await harness.get().dispatch({ type: "browser.open", url: "https://example.com" }); });
  const tabId = item(harness.get().browserTabs[0]).id;

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "shot-1", taskId, op: "browser", read: { op: "screenshot", fullPage: true, timeoutMs: 5_000 } });
  });

  assert.deepEqual(desktop.browserCalls.at(-1), ["capture", tabId, true, 5_000]);
  const shot = browserReadResult(desktop.threadAnswers.at(-1));
  if (shot.kind !== "shot") assert.fail("Expected a browser picture");
  assert.equal(shot.shot.path, "/tmp/shot.png");
  assert.equal(shot.shot.tabId, tabId);

  await harness.view.unmount();
});
