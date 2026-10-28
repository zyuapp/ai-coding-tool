import { seedTaskWithSubagent } from "../support/subagents.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import { outbox } from "../support/composer-outbox.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";

import { settleUntil } from "../support/settle.mts";

import type { ExecutionPolicy } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

function agentRow(container: Element, name: string) {
  const row = [...container.querySelectorAll<HTMLButtonElement>(".agent-row")].find((button) => button.querySelector("strong")?.textContent === name);
  assert.ok(row, `no subagent row named ${name}`);
  return row;
}

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");
const { SideChat } = await import("../../src/renderer/components/SideChat.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

test("a side chat opened from the right panel sends on the side channel and stops on request", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "main-task",
      title: "Main task",
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 1,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });

  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(textarea, "What does this code do?");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "What does this code do?" }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send side chat message"]').click(); });

  const start = startCommand(desktop.sent[0]);
  assert.equal(start.channel, "side");
  assert.equal(start.forkContinuation, true);
  assert.deepEqual(start.continuation, { provider: "claude", value: "main-session" });
  assert.equal(textarea.value, "");

  assert.ok(
    desktop.persisted.every((delta) => (delta.tasks ?? []).every((entry) => entry.task.id !== start.taskId)),
    "a side chat's thread never reaches the store",
  );

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop side chat"]').click(); });
  assert.deepEqual(desktop.sent.at(-1), { type: "cancel", taskId: start.taskId, runId: start.runId });
  await view.unmount();
});

test("a side chat composes with everything the main composer has", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  const decisions: boolean[] = [];
  const policies: ExecutionPolicy[] = [];
  const chatThread: Thread = {
    id: "chat-1",
    title: "Side chat",
    engine: "claude",
    executionPolicy: "allow-edits",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    contextUsage: { tokens: 120_000, limit: 200_000, model: "claude-opus-5" },
  };
  type SideChatProps = React.ComponentProps<typeof SideChat>;
  const sideChatProps = (prompt: string, onPrompt: SideChatProps["onPrompt"]): SideChatProps => ({
    chat: {
      id: "chat-1",
      title: "Chat 1",
      sourceThreadId: "main-task",
      error: null,
      thread: chatThread,
      compacting: false,
      retrying: null,
      status: "running",
      streamingTail: null,
      queuedMessages: [],
      annotations: [], pastes: [], images: [], files: [],
      readingPoint: null,
      running: true,
      approval: { approvalId: "approval-1", taskId: "chat-1", runId: "run-1", title: "Run a command", description: "ls", toolName: "Bash", input: { command: "ls" } },
      prompt,
    },
    engineLabel: "Claude",
    sourceTitle: "Main",
    sourceContinued: true,
    onPrompt,
    onAnnotateAdd() {},
    onAnnotateNote() {},
    onAnnotateRecall() {},
    onAnnotateRemove() {},
    onPasteAdd() {},
    onPasteRecall() {},
    onPasteRemove() {},
    onFilesAdd() {}, onFileRecall() {}, onFileRemove() {}, onImageRecall() {},
    onImageRemove() {},
    outbox: outbox(),
    onCancel() {},
    onDecide(_approval, allow) { decisions.push(allow); },
    onPolicyChange(policy) { policies.push(policy); },
    onModelChange() {},
    onEffortChange() {}, onFastModeChange() {},
    onSteerQueued() {},
    onEditQueued() {}, onDropQueued() {},
    onClose() {},
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(SideChat, sideChatProps(prompt, setPrompt));
  }
  const view = await mount(React.createElement(Harness));
  await act(async () => {});

  const usage = query(view.container, ".context-usage");
  assert.equal(query(usage, '[role="meter"]').getAttribute("aria-valuetext"), "60% used");
  assert.match(usage.textContent, /120K \/ 200K tokens used/);

  const settings = view.container.querySelectorAll<HTMLDetailsElement>(".composer-settings .setting-menu");
  assert.equal(settings.length, 2, "permission mode, and model with its effort");
  assert.match(query(item(settings[1]), "summary").getAttribute("aria-label")!, /^Model and effort: .+, .+$/);
  assert.equal(query(item(settings[0]), "summary").getAttribute("aria-label"), "Permission mode: Edits", "the chip says its current value aloud");
  assert.equal(query(item(settings[0]), ".setting-value").textContent, "Edits", "the chat's own policy is selected, not the first one on offer");
  await act(async () => { query<HTMLElement>(item(settings[0]), "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...item(settings[0]).querySelectorAll(".setting-option")].map((option) => [query(option, "strong").textContent, query(option, "small").textContent]),
    [["Auto", "Only ask for potentially unsafe actions"], ["Bypass", "Use tools and change files without asking"], ["Edits", "Apply file edits without asking"], ["Confirm", "Ask before using tools or changing files"]],
  );
  await act(async () => { item([...item(settings[0]).querySelectorAll<HTMLButtonElement>(".setting-option")].find((option) => option.textContent.includes("Auto"))).click(); });
  assert.deepEqual(policies, ["autonomous"]);

  const approval = query(view.container, ".approval-card");
  assert.match(approval.textContent, /Run a command/);
  await act(async () => { item([...approval.querySelectorAll("button")].at(-1)).click(); });
  assert.deepEqual(decisions, [true]);

  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  assert.ok(view.container.querySelector(".composer-wrap.side .composer"), "the side chat uses the shared composer");

  const paste = new dom.window.Event("paste", { bubbles: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] } });
  await act(async () => { textarea.dispatchEvent(paste); });
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1, "a side chat takes a pasted image");
  await view.unmount();
});

test("closing subagent details returns to the agents tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  assert.ok(view.container.querySelector('[aria-label="Choose a right panel"]'));
  assert.equal(view.container.querySelector('.right-dock [role="tab"]'), null);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Subagents panel"]').click(); });
  assert.match(query(view.container, '.right-dock [role="tab"]').textContent, /Subagents/);
  await act(async () => { agentRow(view.container, "Complete agent").click(); });
  assert.ok(view.container.querySelector(".subagent-inspector"));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Close subagent details"]').click(); });
  assert.ok(view.container.querySelector(".agents-panel")?.textContent?.includes("Complete agent"));

  await view.unmount();
});

test("a view opened in the dock takes the caret with it", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "task-1",
      title: "Inspect",
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'), "the chat is opened to type in");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.textContent.includes("Browser"))).click(); });
  assert.equal(document.activeElement, view.container.querySelector('.browser-bar input[aria-label="Address"]'), "a page with no address yet asks for one");

  await view.unmount();
});

test("hiding the panel hands the caret back instead of losing it", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "task-1",
      title: "Inspect",
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Hide right panel"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Task prompt"]'), "the composer takes the keyboard the hidden panel was holding");

  await view.unmount();
});

test("session summary stays outside the tabbed right panel", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
  assert.ok(view.container.querySelector('.workspace > .session-panel'));
  assert.equal(view.container.querySelector('.right-dock .session-panel'), null);
  await act(async () => { agentRow(view.container, "Complete agent").click(); });
  assert.equal(view.container.querySelector('.workspace > .session-panel'), null);
  assert.ok(view.container.querySelector('.right-dock .subagent-inspector'));

  await view.unmount();
});

test("right panel keeps multiple side chats mounted as tabs", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const add = query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });
  await act(async () => { add.click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });

  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 2);
  assert.equal(view.container.querySelectorAll('.side-chat').length, 2);
  assert.equal(view.container.querySelectorAll('.right-dock-content > div[hidden]').length, 2, "only the picker and inactive chat stay hidden");
  await view.unmount();
});

test("every right panel view opens as a closable tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const labels = [...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button:not([aria-disabled])")].map((button) => button.getAttribute("aria-label"));
  assert.ok(labels.length >= 3);

  for (const label of labels) {
    await act(async () => { query<HTMLButtonElement>(view.container, `.right-dock-picker button[aria-label="${label}"]`).click(); });
    const tab = [...view.container.querySelectorAll<HTMLElement>(".right-dock-tab")].find((candidate) => candidate.classList.contains("active"));
    assert.ok(tab, `${label} opened no tab`);
    assert.ok(view.container.querySelector(".right-dock-content > div:not([hidden])"), `${label} opened no panel content`);

    const close = tab.querySelector<HTMLButtonElement>('button[aria-label^="Close "]');
    assert.ok(close, `${label} opened a tab that cannot be closed`);
    await act(async () => { close.click(); });
    assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, `${label} left a tab behind`);
    assert.equal(query<HTMLElement>(view.container, ".right-dock-picker").hidden, false);
  }

  await view.unmount();
});

test("right panel resizes with the keyboard", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const workspace = query<HTMLElement>(view.container, ".workspace");
  const panel = query<HTMLElement>(view.container, ".right-dock");
  workspace.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ width: 1000 });
  panel.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ x: 600 });
  await act(async () => { query<HTMLElement>(panel, '[aria-label="Resize right panel"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "410px");
  await view.unmount();
});

test("right panel reports its width and returns to the layout's width on double-click or Enter", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const workspace = query<HTMLElement>(view.container, ".workspace");
  const panel = query<HTMLElement>(view.container, ".right-dock");
  const edge = query<HTMLElement>(panel, '[aria-label="Resize right panel"]');
  workspace.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ width: 1000 });
  panel.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ x: 600, width: 400 });
  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "410px");
  assert.equal(edge.getAttribute("aria-valuemin"), "320");
  assert.equal(edge.getAttribute("aria-valuemax"), "680");
  assert.equal(edge.getAttribute("aria-valuenow"), "400");
  assert.equal(edge.getAttribute("aria-valuetext"), "400 pixels wide");
  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "450px", "Shift takes a bigger step");
  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "680px", "End goes to the widest");
  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "320px", "Home goes to the narrowest");

  await act(async () => { edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "");

  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "");
  await view.unmount();
});

test("the right panel's tabs are one stop for Tab, walked with the arrow keys, and close on a middle click", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  for (let opened = 0; opened < 3; opened += 1) {
    await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-picker button[aria-label="Open Browser panel"]').click(); });
  }
  const tabs = () => [...view.container.querySelectorAll<HTMLButtonElement>('.right-dock [role="tab"]')];
  assert.equal(tabs().length, 3);
  assert.equal(tabs().filter((tab) => tab.tabIndex === 0).length, 1, "only the selected tab is in the Tab order");

  const active = tabs().findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  tabs()[active].focus();
  await act(async () => { tabs()[active].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  assert.equal(dom.window.document.activeElement, tabs()[(active + 1) % tabs().length]);
  await act(async () => { item(dom.window.document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  assert.equal(dom.window.document.activeElement, tabs()[0]);

  const count = tabs().length;
  await act(async () => { item(tabs()[0].closest(".right-dock-tab")).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })); });
  assert.equal(tabs().length, count - 1, "a middle click closes the tab under it");
  await view.unmount();
});

/** One thread and no project; `continued` says whether the thread has a session a side chat can fork. */
function seedLoneThread(continued: boolean) {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "main-task",
      title: "Main task",
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      ...(continued ? { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" } : { continuationStatus: "none" }),
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 1,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
}

test("the right panel's tabs ignore Backspace and Delete, and End reaches the last tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  for (let opened = 0; opened < 3; opened += 1) {
    await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-picker button[aria-label="Open Browser panel"]').click(); });
  }
  const tabs = () => [...view.container.querySelectorAll<HTMLButtonElement>('.right-dock [role="tab"]')];
  tabs()[0].focus();
  for (const key of ["Backspace", "Delete"]) {
    await act(async () => { tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  }
  assert.equal(tabs().length, 3, "a stray key never closes a tab");
  await act(async () => { tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  assert.equal(dom.window.document.activeElement, tabs()[2]);
  await act(async () => { tabs()[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  assert.equal(dom.window.document.activeElement, tabs()[0], "the walk wraps past the end");
  await view.unmount();
});

test("a mouse wheel turns the tab strip sideways and leaves a sideways scroll alone", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-picker button[aria-label="Open Browser panel"]').click(); });

  const strip = query<HTMLElement>(view.container, '.right-dock [role="tablist"]');
  await act(async () => { strip.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 40, bubbles: true })); });
  assert.equal(strip.scrollLeft, 40);
  await act(async () => { strip.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaX: 25, deltaY: 40, bubbles: true })); });
  assert.equal(strip.scrollLeft, 40, "a trackpad's own sideways scroll is not added to");
  await view.unmount();
});

test("an add-menu entry that cannot open stays reachable, says why, and does nothing when pressed", async () => {
  seedLoneThread(true);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });

  const entry = (title: string) => item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add [role="menuitem"]')].find((button) => button.textContent === title));
  const terminal = entry("Terminal");
  assert.equal(terminal.getAttribute("aria-disabled"), "true");
  assert.equal(terminal.disabled, false, "the keyboard can still rest on it");
  assert.equal(terminal.dataset.tip, "Open a project to start a terminal");
  await act(async () => { terminal.click(); });
  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 0);
  assert.ok(view.container.querySelector('.right-dock-add [role="menu"]'), "the menu stays open on an entry that cannot act");

  const sideChat = entry("Side chat");
  assert.equal(sideChat.dataset.tip, undefined);
  await act(async () => { sideChat.click(); });
  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 1);
  await view.unmount();
});

test("a side chat with no main context to fork offers the main thread's composer", async () => {
  seedLoneThread(false);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });

  const go = query<HTMLButtonElement>(view.container, ".side-chat-action button");
  assert.equal(go.textContent, "Message Main task");
  await act(async () => { go.click(); });
  await settleUntil(() => dom.window.document.activeElement === view.container.querySelector('textarea[aria-label="Task prompt"]'), "the main thread's composer takes the caret");
  await view.unmount();

  seedLoneThread(true);
  const continued = await mount(React.createElement(App));
  await act(async () => { query<HTMLButtonElement>(continued.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(continued.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...continued.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });
  assert.equal(continued.container.querySelector(".side-chat-action"), null, "a chat that can fork asks nothing of the main thread");
  await continued.unmount();
});

test("a strip with tabs past its edges offers every tab in one list", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const proto = dom.window.HTMLElement.prototype;
  const scrollWidth = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const clientWidth = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  let tight = false;
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return tight && this.getAttribute("role") === "tablist" ? 600 : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "tablist" ? 300 : 0; } });
  try {
    const view = await mount(React.createElement(App));
    await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
    await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-picker button[aria-label="Open Browser panel"]').click(); });
    assert.equal(view.container.querySelector(".right-dock-overflow"), null, "a strip that shows every tab needs no list");

    tight = true;
    for (let opened = 0; opened < 2; opened += 1) {
      await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
      await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add [role="menuitem"]')].find((button) => button.textContent === "Browser")).click(); });
    }
    const tabs = () => [...view.container.querySelectorAll<HTMLButtonElement>('.right-dock [role="tab"]')];
    assert.equal(tabs().length, 3);
    await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-overflow > button').click(); });
    const entries = [...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-overflow [role="menuitemradio"]')];
    assert.equal(entries.length, 3);
    const checked = entries.findIndex((entry) => entry.getAttribute("aria-checked") === "true");
    assert.equal(dom.window.document.activeElement, entries[checked], "the list opens on the tab being shown");

    await act(async () => { entries[0].click(); });
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
    assert.equal(view.container.querySelector('.right-dock-overflow [role="menu"]'), null, "picking a tab closes the list");
    await view.unmount();
  } finally {
    if (scrollWidth) Object.defineProperty(proto, "scrollWidth", scrollWidth);
    else Reflect.deleteProperty(proto, "scrollWidth");
    if (clientWidth) Object.defineProperty(proto, "clientWidth", clientWidth);
    else Reflect.deleteProperty(proto, "clientWidth");
  }
});
