import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { DiffToolbarProps } from "../../../src/renderer/components/DiffToolbar.tsx";
import type { DiffState } from "../../../src/application/workspace-state.ts";

const { DiffToolbar } = await import("../../../src/renderer/components/DiffToolbar.tsx");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function diffState(overrides: Partial<DiffState> = {}): DiffState {
  return {
    mode: "uncommitted",
    workspaceId: "workspace-1",
    range: { kind: "uncommitted" },
    result: null,
    loading: false,
    collapsed: [],
    viewed: {},
    split: false,
    ignoreWhitespace: false,
    ...overrides,
  };
}

function toolbar(overrides: Partial<DiffToolbarProps> = {}) {
  const props: DiffToolbarProps = {
    diff: diffState(),
    split: false,
    roomForTwo: true,
    workspaceId: "workspace-1",
    openMenu: null,
    onSetOpenMenu: () => {},
    onSetMode: () => {},
    onSetRange: () => {},
    onToggleSplit: () => {},
    onToggleWhitespace: () => {},
    onRefresh: () => {},
  };
  return React.createElement(DiffToolbar, { ...props, ...overrides });
}

test("a reviewed commit's chip copies its full hash and says so", async () => {
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const view = await mount(toolbar({ diff: diffState({ mode: "commit", range: { kind: "commit", commit: COMMIT } }) }));
  const chip = query<HTMLButtonElement>(view.container, ".diff-linked-commit");
  assert.equal(chip.textContent, COMMIT.slice(0, 7));
  assert.equal(chip.dataset.tip, `Copy ${COMMIT}`);
  assert.equal(chip.closest(".diff-toolbar-lead")?.querySelector(".diff-mode-trigger > span")?.textContent, "Commit", "the chip sits beside the mode it belongs to");

  await act(async () => { chip.click(); });
  assert.deepEqual(copied, [COMMIT]);
  assert.equal(chip.dataset.tip, "Copied");
  assert.ok(chip.classList.contains("copied"));
  await view.unmount();
});

test("without a project the pickers stay focusable, say why, and open nothing", async () => {
  const opened: Array<string | null> = [];
  const view = await mount(toolbar({ workspaceId: undefined, diff: diffState({ mode: "branch", range: { kind: "branches", base: "main", compare: null } }), onSetOpenMenu: (menu) => opened.push(menu) }));
  const triggers = [...view.container.querySelectorAll<HTMLButtonElement>(".diff-mode-trigger, .diff-side-trigger")];
  assert.equal(triggers.length, 3);
  for (const trigger of triggers) {
    assert.equal(trigger.disabled, false);
    assert.equal(trigger.getAttribute("aria-disabled"), "true");
    assert.equal(trigger.dataset.tip, "Open a project to review changes");
    await act(async () => { trigger.click(); });
  }
  assert.equal(opened.length, 0);
  await view.unmount();

  const open = await mount(toolbar({ diff: diffState({ mode: "branch", range: { kind: "branches", base: "main", compare: null } }), onSetOpenMenu: (menu) => opened.push(menu) }));
  const side = query<HTMLButtonElement>(open.container, ".diff-side-trigger");
  assert.equal(side.getAttribute("aria-disabled"), null);
  await act(async () => { side.click(); });
  assert.equal(opened.length, 1, "with a project the picker opens");
  await open.unmount();
});

test("the spacing toggle names its state, and a read in progress says so", async () => {
  const view = await mount(toolbar({ diff: diffState({ ignoreWhitespace: true, loading: true }) }));
  const spacing = query<HTMLButtonElement>(view.container, 'button[aria-label="Hide spacing changes"]');
  assert.equal(spacing.getAttribute("aria-pressed"), "true");
  assert.equal(spacing.dataset.tip, "Spacing changes hidden");
  const refresh = query<HTMLButtonElement>(view.container, 'button[aria-label="Refresh changes"]');
  assert.equal(refresh.getAttribute("aria-busy"), "true");
  assert.equal(refresh.dataset.tip, "Refreshing…");
  await view.unmount();
});

test("the mode chip names what it picks", async () => {
  const view = await mount(toolbar());
  const mode = query<HTMLButtonElement>(view.container, ".diff-mode-trigger");
  assert.equal(mode.textContent, "ReviewUncommitted");
  assert.equal(mode.getAttribute("aria-label"), "Review mode: Uncommitted");
  await view.unmount();
});

test("a long branch name keeps its end in view", async () => {
  const view = await mount(toolbar({ currentBranch: "feature/review-panel-polish", diff: diffState({ mode: "branch", range: { kind: "branches", base: "origin/main", compare: null }, ignoreWhitespace: true }) }));
  const [from, into] = [...view.container.querySelectorAll<HTMLElement>(".diff-side-trigger > span")];
  assert.equal(from.textContent, "feature/review-panel-polish · working");
  assert.equal(from.lastElementChild?.textContent, "nel-polish · working");
  assert.equal(into.childElementCount, 1, "a short name is not split");
  await view.unmount();
});
