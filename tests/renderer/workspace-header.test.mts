import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { Thread } from "../../src/domain/thread.ts";
import { mount, query } from "../support/renderer-dom.mts";

const { WorkspaceHeader } = await import("../../src/renderer/components/WorkspaceHeader.tsx");

function headerProps(overrides: Partial<React.ComponentProps<typeof WorkspaceHeader>> = {}): React.ComponentProps<typeof WorkspaceHeader> {
  return {
    currentThread: {
      id: "codex-thread", title: "Codex thread", engine: "codex", executionPolicy: "confirm", messages: [],
      continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
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

test("the heading's title renames on one click and its project crumb is plain text", async () => {
  const renames: Array<[string, string]> = [];
  const view = await mount(React.createElement(WorkspaceHeader, headerProps({
    onRenameThread: (threadId: string, title: string) => { renames.push([threadId, title]); },
  })));
  try {
    const title = query<HTMLButtonElement>(view.container, "button.heading-thread");
    assert.equal(title.dataset.tip, "Rename");
    assert.ok(title.querySelector("svg"), "the title carries a pencil, so renaming is found without hovering");
    await act(async () => { title.click(); });
    const input = query<HTMLInputElement>(view.container, "input.heading-rename");
    await act(async () => {
      input.value = "Renamed";
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(renames, [["codex-thread", "Renamed"]]);

    const project = query(view.container, ".heading-project");
    assert.equal(project.tagName, "SPAN");
    assert.equal(project.textContent, "project");
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
      continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
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
  assert.equal(query(remote.container, ".task-heading h1").dataset.tip, "/home/me/just-speak-linux on zyuapp");
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
    assert.equal(state.textContent, "OfflineReconnect");
    await act(async () => { state.click(); });
    assert.deepEqual(sent, [{ type: "computers.reconnect", id: "laptop-id" }]);
    await view.render(header({ id: "laptop-id", name: "laptop", offline: true, reconnecting: true }));
    assert.equal(view.container.querySelector("button.heading-host-state"), null);
    const reconnecting = query(view.container, ".heading-host-state");
    assert.equal(reconnecting.getAttribute("role"), "status");
    assert.equal(reconnecting.textContent, "Reconnecting…");
  } finally { await view.unmount(); }
});

test("zen mode keeps its place in the toolbar and says why it is off on an empty thread", async () => {
  let entered = 0;
  const zen = (available: boolean) => ({ available, tip: "Zen mode (⌘⇧F)", onEnter: () => { entered += 1; } });
  const view = await mount(React.createElement(WorkspaceHeader, headerProps({ zen: zen(false) })));
  try {
    const off = query<HTMLButtonElement>(view.container, 'button[aria-label="Enter zen mode"]');
    assert.equal(off.getAttribute("aria-disabled"), "true");
    assert.equal(off.dataset.tip, "Zen mode (⌘⇧F) · Send a message first");
    await act(async () => { off.click(); });
    assert.equal(entered, 0);
    await view.render(React.createElement(WorkspaceHeader, headerProps({ zen: zen(true) })));
    const on = query<HTMLButtonElement>(view.container, 'button[aria-label="Enter zen mode"]');
    assert.equal(on.hasAttribute("aria-disabled"), false);
    assert.equal(on.dataset.tip, "Zen mode (⌘⇧F)");
    await act(async () => { on.click(); });
    assert.equal(entered, 1);
  } finally { await view.unmount(); }
});
