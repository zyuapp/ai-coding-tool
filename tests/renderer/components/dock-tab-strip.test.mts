import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { LuBot as Bot, LuFileDiff as FileDiff, LuGitFork as GitFork } from "react-icons/lu";

import type { DockTab } from "../../../src/renderer/components/dock-registry.tsx";

const { DockTabStrip } = await import("../../../src/renderer/components/DockTabStrip.tsx");

const TABS: DockTab[] = [
  { id: "agents", title: "Subagents", icon: Bot, badge: 2, badgeLabel: "2 working", badgeTone: "working" },
  { id: "diff", title: "Changes", icon: FileDiff, badge: 3, badgeLabel: "3 files unreviewed" },
  { id: "side-1", title: "Side question", icon: GitFork, unread: true },
];

type StripProps = Parameters<typeof DockTabStrip>[0];

function strip(overrides: Partial<StripProps> = {}) {
  const workspace = { openMenu: null, actions: { setOpenMenu: () => {}, selectDockTab: async () => {}, setDockExpanded: async () => {}, setDockOpen: async () => {} } };
  return React.createElement(DockTabStrip, {
    workspace: workspace as unknown as StripProps["workspace"],
    tabs: TABS,
    launchers: [],
    activeTab: "diff",
    expanded: false,
    sidebarOpen: true,
    addMenuOpen: false,
    addMenu: React.createRef<HTMLDivElement>(),
    addMenuTrigger: React.createRef<HTMLButtonElement>(),
    onCloseTab: () => {},
    ...overrides,
  });
}

test("a count of work going on reads apart from a count to review", async () => {
  const view = await mount(strip());
  const badge = (id: string) => query(view.container, `[data-dock-tab="${id}"] [role="tab"] > em`);
  assert.equal(badge("agents").className, "working");
  assert.equal(badge("diff").className, "");
  await view.unmount();
});

test("a tab waiting on the user is marked by more than its dot", async () => {
  const view = await mount(strip());
  const tab = query(view.container, '[data-dock-tab="side-1"]');
  assert.ok(tab.classList.contains("unread"));
  assert.ok(tab.querySelector('.right-dock-tab-attention[aria-label="Waiting for you"]'));
  assert.equal(query(view.container, '[data-dock-tab="diff"]').classList.contains("unread"), false);
  await view.unmount();
});

test("a focused tab closes on Delete, and its close button names the key", async () => {
  const closed: string[] = [];
  const view = await mount(strip({ onCloseTab: (id) => closed.push(id) }));
  const tab = query<HTMLButtonElement>(view.container, '[data-dock-tab="side-1"] [role="tab"]');
  tab.focus();
  await act(async () => { tab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); });
  assert.deepEqual(closed, ["side-1"]);
  assert.match(query(view.container, '[data-dock-tab="side-1"] > button:not([role="tab"])').dataset.tip ?? "", /^Close tab \((⌦|Delete)\)$/);
  await view.unmount();
});

test("the add menu teaches each panel's slash command, except on one that cannot open", async () => {
  const launcher = (id: string, disabled: boolean) => ({ id, title: id, description: "", command: id, icon: Bot, open: () => {}, disabled, disabledLabel: disabled ? "Not here" : undefined, disabledReason: disabled ? "Not here" : undefined });
  const view = await mount(strip({ addMenuOpen: true, launchers: [launcher("browser", false), launcher("terminal", true)] as unknown as StripProps["launchers"] }));
  const items = [...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add [role="menuitem"]')];
  assert.deepEqual(items.map((entry) => entry.querySelector("kbd")?.textContent ?? null), ["/browser", null]);
  await view.unmount();
});
