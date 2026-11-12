import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { Thread } from "../../src/domain/thread.ts";
import { mount, query } from "../support/renderer-dom.mts";
import { settleFrame } from "../support/settle.mts";

const { WorkspaceHeader } = await import("../../src/renderer/components/WorkspaceHeader.tsx");

function headerProps(overrides: Partial<React.ComponentProps<typeof WorkspaceHeader>> = {}): React.ComponentProps<typeof WorkspaceHeader> {
  return {
    currentThread: {
      id: "codex-thread", title: "Codex thread", engine: "codex", executionPolicy: "confirm", messages: [],
      continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, rankedAt: 1, updatedAt: 1,
    } satisfies Thread,
    folder: "/project", folderLabel: "project", sidebarOpen: true, sessionPanelOpen: false, rightDockOpen: false,
    zen: { available: true, tip: "Zen mode", onEnter: () => {} },
    workingSubagents: 0, openMenu: null, canOpenFolder: true, apps: null,
    onListApps() {}, onSetOpenMenu() {}, onOpenInApp() {}, onRenameThread() {}, onForkThread() {}, onSetThreadRole() {},
    coordinators: [], onSetCoordinator() {}, notifications: true, onSetMuted() {}, stoppable: false, onStopAll() {}, onArchiveThread() {},
    onToggleSidebar() {}, onToggleSessionPanel() {}, onToggleRightDock() {}, onChooseFolder() {},
    ...overrides,
  };
}

test("the heading's title renames on one click", async () => {
  const renames: Array<[string, string]> = [];
  const view = await mount(React.createElement(WorkspaceHeader, headerProps({
    onRenameThread: (threadId: string, title: string) => { renames.push([threadId, title]); },
  })));
  try {
    const title = query<HTMLButtonElement>(view.container, "button.heading-thread");
    assert.equal(title.dataset.tip, "Codex thread");
    assert.equal("tipOverflow" in title.dataset, true, "a cut-short title shows in full on hover and focus");
    assert.equal(query<SVGElement>(title, "svg").dataset.tip, "Rename");
    await act(async () => { title.click(); });
    const input = query<HTMLInputElement>(view.container, "input.heading-rename");
    await act(async () => {
      input.value = "Renamed";
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(renames, [["codex-thread", "Renamed"]]);

  } finally { await view.unmount(); }
});

test("a blank title is refused in place rather than quietly reverted", async () => {
  const renames: Array<[string, string]> = [];
  const view = await mount(React.createElement(WorkspaceHeader, headerProps({
    onRenameThread: (threadId: string, title: string) => { renames.push([threadId, title]); },
  })));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, "button.heading-thread").click(); });
    const input = query<HTMLInputElement>(view.container, "input.heading-rename");
    await act(async () => {
      input.value = "  ";
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(view.container.querySelector("input.heading-rename"), input, "the field stays open");
    assert.ok(input.classList.contains("invalid"));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.deepEqual(renames, []);
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(query(view.container, "button.heading-thread").textContent, "Codex thread");
    await settleFrame();
    assert.equal(document.activeElement, query(view.container, "button.heading-thread"), "and the keys go back to the title");
  } finally { await view.unmount(); }
});

test("the project crumb names the folder's path, and only the toolbar button opens the Open in list", async () => {
  let menu: string | null = null;
  let listed = 0;
  const props = (overrides: Partial<React.ComponentProps<typeof WorkspaceHeader>> = {}) => headerProps({
    folder: "/home/me/project",
    openMenu: menu,
    apps: [{ id: "finder", label: "Finder", kind: "files" }] as React.ComponentProps<typeof WorkspaceHeader>["apps"],
    onSetOpenMenu: (next: string | null) => { menu = next; },
    onListApps: () => { listed += 1; },
    ...overrides,
  });
  const view = await mount(React.createElement(WorkspaceHeader, props()));
  try {
    const crumb = query<HTMLElement>(view.container, ".heading-project");
    assert.equal(crumb.textContent, "project");
    assert.equal(crumb.dataset.tip, "/home/me/project");
    assert.equal(crumb.querySelector("button"), null, "the crumb is a label, not a second Open in trigger");
    const openIn = query<HTMLButtonElement>(view.container, '.open-in > button[aria-haspopup="menu"]');
    await act(async () => { openIn.click(); });
    await view.render(React.createElement(WorkspaceHeader, props()));
    assert.equal(openIn.getAttribute("aria-expanded"), "true");
    assert.equal(listed, 1);
    assert.equal(query(view.container, '.open-in-popover [role="menuitem"]').textContent, "Finder");

    menu = null;
    await view.render(React.createElement(WorkspaceHeader, props({ canOpenFolder: false })));
    assert.equal(openIn.getAttribute("aria-disabled"), "true");
    await act(async () => { openIn.click(); });
    assert.equal(menu, null);
  } finally { await view.unmount(); }
});

test("an empty heading offers the folder choice and leaves out what it cannot do yet", async () => {
  let chosen = 0;
  const view = await mount(React.createElement(WorkspaceHeader, headerProps({
    currentThread: undefined, folder: "", folderLabel: "",
    zen: { available: false, tip: "Zen mode", onEnter: () => {} },
    onChooseFolder: () => { chosen += 1; },
  })));
  try {
    assert.equal(view.container.querySelector(".heading-project"), null);
    assert.equal(view.container.querySelector("button.heading-thread"), null, "a draft has no title to rename");
    assert.equal(view.container.querySelector('button[aria-label="Enter zen mode"]'), null);
    assert.equal(view.container.querySelector(".open-in"), null);
    await act(async () => { query<HTMLButtonElement>(view.container, ".heading-choose-folder").click(); });
    assert.equal(chosen, 1);
  } finally { await view.unmount(); }
});

test("the heading names the paired computer a thread lives on, ahead of its folder", async () => {
  const props = {
    currentThread: {
      id: "remote-thread", title: "What is in this repo", engine: "claude", executionPolicy: "confirm", messages: [],
      continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, rankedAt: 1, updatedAt: 1,
    } satisfies Thread,
    folder: "/home/me/just-speak-linux",
    folderLabel: "just-speak-linux",
    sidebarOpen: false, sessionPanelOpen: false, rightDockOpen: false, zen: { available: false, tip: "Zen mode", onEnter: () => {} }, workingSubagents: 0, openMenu: null, canOpenFolder: true, apps: null,
    onListApps: () => {}, onSetOpenMenu: () => {}, onOpenInApp: () => {}, onRenameThread: () => {}, onForkThread: () => {}, onSetThreadRole: () => {}, onArchiveThread: () => {},
    coordinators: [], onSetCoordinator: () => {}, notifications: true, onSetMuted: () => {}, stoppable: false, onStopAll: () => {},
    onToggleSidebar: () => {}, onToggleSessionPanel: () => {}, onToggleRightDock: () => {}, onChooseFolder: () => {},
  };
  const local = await mount(React.createElement(WorkspaceHeader, props));
  assert.equal(local.container.querySelector(".heading-host"), null, "a thread here carries no computer");
  await local.unmount();

  const remote = await mount(React.createElement(WorkspaceHeader, { ...props, host: { id: "zyuapp-id", name: "zyuapp", offline: false } }));
  const mark = query(remote.container, ".task-heading h1 > .heading-host");
  assert.equal(mark.textContent, "zyuapp");
  assert.equal(mark.nextElementSibling?.className, "heading-separator");
  assert.equal(mark.nextElementSibling?.nextElementSibling?.textContent, "just-speak-linux");
  assert.equal(query(remote.container, ".heading-project").dataset.tip, "/home/me/just-speak-linux on zyuapp");
  await remote.unmount();

  const away = await mount(React.createElement(WorkspaceHeader, { ...props, host: { id: "zyuapp-id", name: "zyuapp", offline: true } }));
  assert.equal(query(away.container, ".heading-host").classList.contains("offline"), true);
  await away.unmount();
});

test("an offline computer says so in the heading and reconnects from there", async () => {
  const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
  const sent: unknown[] = [];
  const header = (host: React.ComponentProps<typeof WorkspaceHeader>["host"]) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: unknown) => { sent.push(command); } } },
    React.createElement(WorkspaceHeader, headerProps({ host })));
  const view = await mount(header({ id: "laptop-id", name: "laptop", offline: false }));
  try {
    assert.equal(view.container.querySelector(".heading-host-state"), null);
    await view.render(header({ id: "laptop-id", name: "laptop", offline: true }));
    const state = query<HTMLButtonElement>(view.container, "button.heading-host-state");
    assert.equal(state.textContent, "Reconnect");
    await act(async () => { state.click(); });
    assert.deepEqual(sent, [{ type: "computers.reconnect", id: "laptop-id" }]);
    await view.render(header({ id: "laptop-id", name: "laptop", offline: true, reconnecting: true }));
    assert.equal(view.container.querySelector("button.heading-host-state"), null);
    const reconnecting = query(view.container, ".heading-host-state");
    assert.equal(reconnecting.getAttribute("role"), "status");
    assert.equal(reconnecting.textContent, "Reconnecting…");
  } finally { await view.unmount(); }
});
