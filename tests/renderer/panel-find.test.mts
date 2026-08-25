import assert from "node:assert/strict";
import { test } from "vitest";
import React, { useRef } from "react";
import { settleUntil } from "../support/settle.mts";
import type { FindView } from "../../src/application/workspace-state.ts";
import type { FindResults } from "../../src/domain/find.ts";
import type { DockPanel } from "../../src/renderer/components/dock-registry.tsx";
import { Bot } from "lucide-react";

import { dom, mount, query } from "../support/renderer-dom.mts";

const { usePanelFind } = await import("../../src/renderer/find/use-panel-find.ts");
const { DockPanelTab } = await import("../../src/renderer/components/DockContent.tsx");

function find(query: string, index = 0): FindView {
  return { target: { kind: "panel", owner: "task-a", panel: "agents" }, query, index, focus: 1, matches: 0, counting: false, hit: null };
}

/** A panel drawn from whatever lines it is given, searched the way every small panel is. */
function Panel({ lines, view, onResults }: { lines: string[]; view: FindView | null; onResults: (results: FindResults) => void }) {
  const body = useRef<HTMLDivElement>(null);
  usePanelFind({ root: body, find: view, onResults });
  return React.createElement("div", { ref: body }, lines.map((line, at) => React.createElement("p", { key: at }, line)));
}

test("one searcher counts what a panel drew, and counts again when it redraws", async () => {
  const reports: FindResults[] = [];
  const panel = await mount(React.createElement(Panel, {
    lines: ["Reading files", "Running the build"],
    view: find("run"),
    onResults: (results: FindResults) => reports.push(results),
  }));

  assert.deepEqual(reports, [{ matches: 1 }], "the panel says how many it found, once");

  await panel.render(React.createElement(Panel, {
    lines: ["Reading files", "Running the build", "Run finished"],
    view: find("run"),
    onResults: (results: FindResults) => reports.push(results),
  }));
  await settleUntil(() => reports.length === 2);

  assert.deepEqual(reports.at(-1), { matches: 2 }, "a row arriving under an open search is counted too");

  await panel.render(React.createElement(Panel, {
    lines: ["Reading files", "Running the build", "Run finished"],
    view: find("run", 1),
    onResults: (results: FindResults) => reports.push(results),
  }));

  assert.equal(reports.length, 2, "stepping is the reducer's, so moving through the matches reports nothing");
  await panel.unmount();
});

test("a panel with nothing to search reports nothing at all", async () => {
  const reports: FindResults[] = [];
  const panel = await mount(React.createElement(Panel, {
    lines: ["Reading files"],
    view: null,
    onResults: (results: FindResults) => reports.push(results),
  }));

  assert.deepEqual(reports, [], "a panel nobody is searching is never asked what it found");
  await panel.unmount();
});

test("a fresh query is answered even when it finds exactly as many as the last one", async () => {
  const reports: FindResults[] = [];
  const props = { lines: ["Reading files"], onResults: (results: FindResults) => reports.push(results) };
  const panel = await mount(React.createElement(Panel, { ...props, view: find("zz") }));

  assert.deepEqual(reports, [{ matches: 0 }], "nothing in the panel says zz");

  await panel.render(React.createElement(Panel, { ...props, view: find("zzz") }));

  assert.deepEqual(reports, [{ matches: 0 }, { matches: 0 }], "the reducer threw the last count away, so the new query says its own");
  await panel.unmount();
});

test("a panel takes the keyboard when it is asked, so find knows the panel is what is being read", async () => {
  const panel: DockPanel = {
    id: "agents",
    title: "Subagents",
    description: "View work delegated from this task",
    icon: Bot,
    render: () => React.createElement("p", null, "Reading files"),
  };
  const props = { panel, active: true, find: null, findBar: null, onResults() {} };
  const tab = await mount(React.createElement(DockPanelTab, { ...props, focusToken: 0 }));

  const body = query(dom.window.document.body, ".dock-panel-body");
  assert.equal(body.getAttribute("tabindex"), "-1", "a panel is read rather than typed into, so the body itself holds the keys");
  assert.notEqual(dom.window.document.activeElement, body, "nothing has asked for the panel yet");

  await tab.render(React.createElement(DockPanelTab, { ...props, focusToken: 1 }));

  assert.equal(dom.window.document.activeElement, body, "asking the panel for the keyboard puts them in it");
  assert.equal(body.closest("[data-dock-tab]")?.getAttribute("data-dock-tab"), "agents", "and the keys are found under the tab that owns them");
  await tab.unmount();
});
