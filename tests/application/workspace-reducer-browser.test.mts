import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { dock, task, workspace, preferences, effectAt, effectOf, required, run, inside } from "./workspace-reducer-fixtures.mts";

test("the user's own page visit opens a dock tab of its own and allows that origin from then on", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "github.com/zyuapp/ai-coding-tool" });
  const [tab] = dock(opened.state).browserTabs;
  assert.ok(tab);

  assert.equal(tab.url, "https://github.com/zyuapp/ai-coding-tool");
  assert.equal(tab.loading, true);
  assert.equal(dock(opened.state).browserTabId, tab.id);
  assert.deepEqual(opened.state.browserOrigins, ["https://github.com"]);
  assert.equal(dock(opened.state).open, true, "a page has to land somewhere the user can see it");
  assert.equal(dock(opened.state).tab, tab.id, "a page is a tab in the dock, not a tab inside a panel");
  assert.deepEqual(opened.effects.filter((effect) => effect.type.startsWith("browser")), [
    { type: "browser.open", tabId: tab.id, url: "https://github.com/zyuapp/ai-coding-tool" },
    { type: "browser.show", tabId: tab.id },
  ]);

  const navigated = reduce(opened.state, { type: "browser.open", url: "https://github.com/zyuapp/ai-coding-tool/pulls" });
  assert.equal(dock(navigated.state).browserTabs.length, 1, "the tab on screen is reused");
  assert.deepEqual(navigated.effects[0], { type: "browser.navigate", tabId: tab.id, url: "https://github.com/zyuapp/ai-coding-tool/pulls" });

  const another = reduce(navigated.state, { type: "browser.open", url: "https://example.com", newTab: true });
  assert.equal(dock(another.state).browserTabs.length, 2);
  assert.deepEqual(another.state.browserOrigins, ["https://github.com", "https://example.com"]);
});

test("a page the browser cannot open is refused rather than opened blank", () => {
  const refused = reduce(workspace(), { type: "browser.open", url: "file:///etc/passwd" });

  assert.deepEqual(dock(refused.state).browserTabs, []);
  assert.deepEqual(refused.effects, []);
  assert.match(required(refused.state.actionError), /not a page the browser can open/);
});

test("a run has to be allowed an origin the user has never visited, and then never again", () => {
  const state = run(workspace(), [
    { type: "view.set-prompt", prompt: "Check the dashboard" },
  ]);
  const withTask = { ...state, threads: [task("task-1")], currentId: "task-1" };

  const asked = reduce(withTask, { type: "browser.open", taskId: "task-1", url: "https://dash.example.com/metrics" });
  const [blank] = dock(asked.state).browserTabs;
  assert.ok(blank);
  assert.equal(blank.url, "", "the ask gets a tab of its own to be shown in, and loads nothing into it");
  assert.deepEqual(asked.state.browserApproval, { url: "https://dash.example.com/metrics", taskId: "task-1", tabId: blank.id });
  assert.equal(dock(asked.state).tab, blank.id, "the ask is shown where the page would have been");

  const blocked = reduce(asked.state, { type: "browser.decide", allow: false });
  assert.equal(blocked.state.browserApproval, null);
  assert.deepEqual(blocked.state.browserOrigins, []);
  assert.deepEqual(dock(blocked.state).browserTabs, [], "a tab that only carried the ask goes with it");

  const allowed = reduce(asked.state, { type: "browser.decide", allow: true });
  assert.deepEqual(allowed.state.browserOrigins, ["https://dash.example.com"]);
  assert.equal(required(dock(allowed.state).browserTabs[0]).url, "https://dash.example.com/metrics");
  assert.equal(allowed.state.browserApproval, null);

  const again = reduce(allowed.state, { type: "browser.open", taskId: "task-1", url: "https://dash.example.com/other" });
  assert.equal(again.state.browserApproval, null, "an allowed origin is not asked about twice");
  assert.equal(effectAt(again, "browser.navigate").type, "browser.navigate");
});

test("a thread trusted to act without asking browses without asking", () => {
  const state = { ...workspace(), threads: [task("task-1", { executionPolicy: "autonomous" })], currentId: "task-1" };

  const opened = reduce(state, { type: "browser.open", taskId: "task-1", url: "https://example.com" });

  assert.equal(opened.state.browserApproval, null);
  assert.equal(required(dock(opened.state).browserTabs[0]).url, "https://example.com/");
  assert.deepEqual(opened.state.browserOrigins, [], "acting without asking is not the user saying yes");
});

test("closing a browser tab hands the panel its neighbour", () => {
  const first = reduce(workspace(), { type: "browser.open", url: "https://one.example" });
  const second = reduce(first.state, { type: "browser.open", url: "https://two.example", newTab: true });
  const [one, two] = dock(second.state).browserTabs;
  assert.ok(one && two);

  const closed = reduce(second.state, { type: "browser.close-tab", tabId: two.id });
  assert.deepEqual(dock(closed.state).browserTabs.map((tab) => tab.id), [one.id]);
  assert.equal(dock(closed.state).browserTabId, one.id);
  assert.deepEqual(closed.effects.filter((effect) => effect.type.startsWith("browser")), [
    { type: "browser.close", tabId: two.id },
    { type: "browser.open", tabId: one.id, url: "https://one.example/" },
    { type: "browser.show", tabId: one.id },
  ]);

  const empty = reduce(closed.state, { type: "browser.close-tab", tabId: one.id });
  assert.equal(dock(empty.state).browserTabId, null);
  assert.deepEqual(empty.effects.filter((effect) => effect.type === "browser.show"), [{ type: "browser.show", tabId: null }]);
});

test("what a page reports is the only thing that writes the tab record", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "https://example.com" });
  const [tab] = dock(opened.state).browserTabs;
  assert.ok(tab);

  const updated = reduce(opened.state, {
    type: "browser.updated",
    page: { tabId: tab.id, url: "https://example.com/welcome", title: "Welcome", loading: false, canGoBack: true },
  });

  assert.deepEqual(dock(updated.state).browserTabs[0], { ...tab, url: "https://example.com/welcome", title: "Welcome", loading: false, canGoBack: true });
  assert.deepEqual(effectOf(updated, "persist-preferences").preferences.browserTabs, { draft: ["https://example.com/welcome"] }, "a page is remembered under the thread whose dock holds it");

  const stray = reduce(updated.state, { type: "browser.updated", page: { tabId: "gone", title: "Nowhere" } });
  assert.equal(stray.state, updated.state);
});

test("a page that fails keeps saying so until the tab lands somewhere else", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "https://example.com/missing" });
  const tabId = required(dock(opened.state).browserTabs[0]).id;

  const failed = run(opened.state, [
    { type: "browser.updated", page: { tabId, loading: false, error: "ERR_NAME_NOT_RESOLVED (https://example.com/missing)" } },
    { type: "browser.updated", page: { tabId, loading: false, url: "https://example.com/missing", title: "" } },
  ]);
  assert.match(required(required(dock(failed).browserTabs[0]).error), /ERR_NAME_NOT_RESOLVED/, "the load settling is not the failure being over");

  const landed = reduce(failed, { type: "browser.updated", page: { tabId, loading: false, url: "https://example.com/", title: "Example" } });
  assert.equal(required(dock(landed.state).browserTabs[0]).error, undefined);
});

test("acting in the browser needs a page, and clearing the session takes back every allowed site", () => {
  const browsing = { ...workspace(), threads: [task("task-1")], currentId: "task-1" };
  const empty = reduce(browsing, { type: "browser.act", taskId: "task-1", action: { kind: "click", ref: "3" } });
  assert.match(required(empty.state.actionError), /no page open/);

  const opened = reduce(browsing, { type: "browser.open", url: "https://example.com" });
  const clicked = reduce(opened.state, { type: "browser.act", taskId: "task-1", action: { kind: "click", ref: "3" } });
  assert.deepEqual(clicked.effects, [{ type: "browser.act", tabId: required(dock(opened.state).browserTabs[0]).id, action: { kind: "click", ref: "3" } }]);

  const cleared = reduce(opened.state, { type: "browser.clear-data" });
  assert.deepEqual(cleared.state.browserOrigins, []);
  assert.equal(cleared.effects[0].type, "browser.clear-data");
});
