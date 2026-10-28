import { mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";
import { LuBot as Bot, LuFileDiff as FileDiff, LuGitFork as GitFork } from "react-icons/lu";

import type { DockTab } from "../../../src/renderer/components/dock-registry.tsx";

const { DockTabStrip } = await import("../../../src/renderer/components/DockTabStrip.tsx");

const TABS: DockTab[] = [
  { id: "agents", title: "Subagents", icon: Bot, badge: 2, badgeLabel: "2 working", badgeTone: "working" },
  { id: "diff", title: "Changes", icon: FileDiff, badge: 3, badgeLabel: "3 files unreviewed" },
  { id: "side-1", title: "Side question", icon: GitFork, unread: true },
];

function strip() {
  const workspace = { openMenu: null, actions: { setOpenMenu: () => {}, selectDockTab: async () => {}, setDockExpanded: async () => {}, setDockOpen: async () => {} } };
  return React.createElement(DockTabStrip, {
    workspace: workspace as unknown as Parameters<typeof DockTabStrip>[0]["workspace"],
    tabs: TABS,
    launchers: [],
    activeTab: "diff",
    expanded: false,
    sidebarOpen: true,
    addMenuOpen: false,
    addMenu: React.createRef<HTMLDivElement>(),
    addMenuTrigger: React.createRef<HTMLButtonElement>(),
    onCloseTab: () => {},
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
