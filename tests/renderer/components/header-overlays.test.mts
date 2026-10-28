import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { ThreadTabView } from "../../../src/application/workspace-state.ts";

const { BranchMenu } = await import("../../../src/renderer/components/BranchMenu.tsx");
const { ThreadTabStrip, scheduleChipLabel, scheduleChipTip } = await import("../../../src/renderer/components/ThreadTabStrip.tsx");
const { FindBar } = await import("../../../src/renderer/components/FindBar.tsx");

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement) {
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
}

test("Enter in the branch search checks out the top match, and makes a name nothing matches", async () => {
  const picks: Array<{ branch: string; create: boolean }> = [];
  const view = await mount(React.createElement(BranchMenu, {
    branches: { status: "available", branches: ["main", "feature-login", "feature-logout"], remotes: [], current: "main" },
    selected: "main",
    onPick: (branch: string, create: boolean) => { picks.push({ branch, create }); },
  }));
  try {
    const input = query<HTMLInputElement>(view.container, 'input[aria-label="Search branches"]');
    await type(input, "feature");
    const labels = [...view.container.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    assert.deepEqual(labels, ["feature-login", "feature-logout", "Create branch “feature”"], "the row Enter takes leads the list");
    await enter(input);
    assert.deepEqual(picks, [{ branch: "feature-login", create: false }]);
    await type(input, "feature-logout");
    assert.equal(view.container.querySelector('[role="option"]')?.textContent, "feature-logout");
    await enter(input);
    assert.deepEqual(picks.at(-1), { branch: "feature-logout", create: false });
    await type(input, "release");
    await enter(input);
    assert.deepEqual(picks.at(-1), { branch: "release", create: true });
  } finally { await view.unmount(); }
});

test("Escape in the branch search clears what was typed before it closes the list", async () => {
  const view = await mount(React.createElement(BranchMenu, {
    branches: { status: "available", branches: ["main"], remotes: [], current: "main" },
    selected: "main",
    onPick: () => {},
  }));
  try {
    const input = query<HTMLInputElement>(view.container, 'input[aria-label="Search branches"]');
    await type(input, "ma");
    const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(escape); });
    assert.equal(input.value, "");
    assert.equal(escape.defaultPrevented, true, "the list stays open");
    const again = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(again); });
    assert.equal(again.defaultPrevented, false, "an empty search lets Escape close the list");
  } finally { await view.unmount(); }
});

test("a branch list still being read says so to assistive technology", async () => {
  const view = await mount(React.createElement(BranchMenu, { branches: null, selected: null, onPick: () => {} }));
  try {
    const note = query(view.container, ".branch-menu-empty");
    assert.equal(note.textContent, "Reading branches…");
    assert.equal(note.getAttribute("role"), "status");
  } finally { await view.unmount(); }
});

test("a branch list Git could not read says why", async () => {
  const view = await mount(React.createElement(BranchMenu, {
    branches: { status: "error", message: "fatal: not a git repository" },
    selected: null,
    onPick: () => {},
  }));
  try {
    const note = query(view.container, ".branch-menu-empty");
    assert.equal(note.textContent, "fatal: not a git repository");
    assert.equal(note.getAttribute("role"), "alert");
    await type(query<HTMLInputElement>(view.container, 'input[aria-label="Search branches"]'), "new");
    assert.equal(view.container.querySelector('[role="option"]'), null, "no branch is offered to a repository that cannot answer");
  } finally { await view.unmount(); }
});

function tab(overrides: Partial<ThreadTabView>): ThreadTabView {
  return {
    thread: { id: "t", title: "T" },
    folder: "/project",
    workspaceId: "w",
    environment: { status: "available", files: [{ path: "a.ts" }], branch: "feat/login", baseline: null, additions: 12, deletions: 3 },
    pullRequest: { status: "found", pullRequest: { url: "https://example.com/pr/42", number: 42, title: "Login", state: "merged" } },
    automation: null,
    ...overrides,
  } as unknown as ThreadTabView;
}

test("the thread strip's chips name what they show to assistive technology", async () => {
  window.desktop = { branches: async () => ({ status: "available", branches: [], remotes: [], current: null }) } as unknown as typeof window.desktop;
  const actions = { onToggleChanges() {}, onOpenAutomations() {}, onSetBranchMenuOpen() {}, onCheckoutBranch() {} };
  const view = await mount(React.createElement(ThreadTabStrip, { tab: tab({}), branchMenuOpen: false, actions }));
  try {
    assert.ok(view.container.querySelector('button[aria-label="Branch feat/login"]'));
    assert.ok(view.container.querySelector('button[aria-label="Review changes, +12 −3"]'));
    assert.equal(query(view.container, ".thread-tab-pull-request").textContent, "#42 · Merged", "the state is a word, not only a colour");
    assert.equal(query(view.container, ".thread-tab-pull-request").dataset.tip, "Login");
    assert.equal(query(view.container, 'button[aria-label="Branch feat/login"]').dataset.tip, "feat/login");
    assert.ok("tipOverflow" in query(view.container, 'button[aria-label="Branch feat/login"]').dataset, "the name only repeats as a tip once it is cut short");
    assert.equal(query(view.container, 'button[aria-label="Review changes, +12 −3"]').dataset.tip, "Uncommitted changes");
    assert.equal(view.container.querySelector("[title]:not([title=''])"), null, "every hint uses the app's tooltip");
    const automations = query(view.container, 'button[data-tip="Automation"]');
    assert.equal(automations.textContent, "Schedule", "an empty schedule reads as an action, not decoration");
    assert.equal(automations.classList.contains("quiet"), false, "it is drawn as the button it is");
    assert.equal(automations.hasAttribute("aria-label"), false, "the visible words are its name");
  } finally { await view.unmount(); }
  const nextRunAt = Date.now() + 60_000;
  const scheduled = await mount(React.createElement(ThreadTabStrip, { tab: tab({ automation: { id: "a", paused: false, nextRunAt } } as unknown as Partial<ThreadTabView>), branchMenuOpen: false, actions }));
  try {
    const chip = query(scheduled.container, 'button[data-tip="Automation"]');
    assert.equal(chip.textContent, scheduleChipLabel({ paused: false, nextRunAt } as never));
    assert.match(chip.textContent ?? "", /^Next /);
    assert.ok(chip.classList.contains("scheduled"));
  } finally { await scheduled.unmount(); }
});

test("the schedule chip names the next run, or why there is none", () => {
  const now = new Date(2026, 9, 28, 8, 0).getTime();
  const at = (days: number, hour: number) => new Date(2026, 9, 28 + days, hour, 0).getTime();
  const automation = (fields: object) => ({ paused: false, nextRunAt: null, ...fields }) as never;
  assert.equal(scheduleChipLabel(null, now), "Schedule");
  assert.equal(scheduleChipLabel(automation({ paused: true, nextRunAt: at(0, 9) }), now), "Paused");
  assert.equal(scheduleChipLabel(automation({}), now), "Missed");
  assert.equal(scheduleChipLabel(automation({ nextRunAt: at(0, 9) }), now), `Next ${new Date(at(0, 9)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  assert.match(scheduleChipLabel(automation({ nextRunAt: at(2, 9) }), now), new RegExp(`^Next ${new Date(at(2, 9)).toLocaleDateString(undefined, { weekday: "short" })}`));
  assert.equal(scheduleChipLabel(automation({ nextRunAt: at(20, 9) }), now), `Next ${new Date(at(20, 9)).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  assert.equal(scheduleChipTip(null), "Automation");
  assert.equal(scheduleChipTip(automation({ paused: true, nextRunAt: at(0, 9) })), "Automation is paused");
  assert.equal(scheduleChipTip(automation({})), "Last run was missed");
  assert.equal(scheduleChipTip(automation({ nextRunAt: at(0, 9) })), "Automation");
});

test("a checkout Git could not read shows the failure with a retry, while reading stays quiet", async () => {
  const { CommandControlsProvider } = await import("../../../src/renderer/components/CommandControl.tsx");
  const sent: unknown[] = [];
  const actions = { onToggleChanges() {}, onOpenAutomations() {}, onSetBranchMenuOpen() {}, onCheckoutBranch() {} };
  const strip = (environment: unknown) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: unknown) => { sent.push(command); } } },
    React.createElement(ThreadTabStrip, { tab: tab({ environment } as Partial<ThreadTabView>), branchMenuOpen: false, actions }));
  const view = await mount(strip(null));
  try {
    const reading = query(view.container, ".thread-tab-note");
    assert.equal(reading.textContent, "Reading Git…");
    assert.ok(reading.querySelector(".text-sweep"), "reading shows as in progress");
    assert.equal(reading.classList.contains("failed"), false);
    assert.equal(view.container.querySelector(".thread-tab-retry"), null);
    await view.render(strip({ status: "error", message: "fatal: bad object HEAD" }));
    const failed = query(view.container, ".thread-tab-note.failed");
    assert.equal(failed.getAttribute("role"), "alert");
    assert.equal(query(failed, "[data-tip]").dataset.tip, "fatal: bad object HEAD");
    await act(async () => { query<HTMLButtonElement>(failed, ".thread-tab-retry").click(); });
    assert.deepEqual(sent, [{ type: "view.refresh-environment" }]);
  } finally { await view.unmount(); }
});

test("the brief toggle names the card it opens", async () => {
  const actions = { onToggleChanges() {}, onOpenAutomations() {}, onSetBranchMenuOpen() {}, onCheckoutBranch() {} };
  const brief = { intent: "Fix it\nThen ship", doneWhen: "Tests pass", delivers: "commit" };
  const view = await mount(React.createElement(ThreadTabStrip, { tab: tab({ thread: { id: "t", title: "T", brief } } as unknown as Partial<ThreadTabView>), branchMenuOpen: false, actions }));
  try {
    const toggle = query<HTMLButtonElement>(view.container, ".thread-tab-brief-toggle");
    assert.equal(toggle.dataset.tip, "Fix it", "the ask shows before the card is opened");
    await act(async () => { toggle.click(); });
    const card = query(view.container, ".thread-tab-brief-card");
    assert.equal(toggle.getAttribute("aria-controls"), card.id);
    assert.equal(toggle.dataset.tip, undefined, "an open card needs no preview");
  } finally { await view.unmount(); }
});

test("the find bar's buttons name their keys", async () => {
  const view = await mount(React.createElement(FindBar, {
    find: { query: "x", matches: 2, index: 0, counting: false, focus: 0 } as React.ComponentProps<typeof FindBar>["find"],
    label: "thread",
    onQuery() {}, onStep() {}, onClose() {},
  }));
  try {
    assert.match(query(view.container, 'button[aria-label="Previous match"]').dataset.tip ?? "", /^Previous match \(/);
    assert.match(query(view.container, 'button[aria-label="Next match"]').dataset.tip ?? "", /^Next match \(/);
    assert.match(query(view.container, 'button[aria-label="Close find"]').dataset.tip ?? "", /^Close \(Esc/);
  } finally { await view.unmount(); }
});
