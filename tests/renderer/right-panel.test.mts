import { seedTaskWithSubagent } from "../support/subagents.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";

import { settleUntil } from "../support/settle.mts";

import type { ExecutionPolicy } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

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
    onSend() {},
    onCancel() {},
    onDecide(allow) { decisions.push(allow); },
    onPolicyChange(policy) { policies.push(policy); },
    onModelChange() {},
    onEffortChange() {},
    onSteerQueued() {},
    onDropQueued() {},
    onClose() {},
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(SideChat, sideChatProps(prompt, setPrompt));
  }
  const view = await mount(React.createElement(Harness));
  await act(async () => {});

  const usage = query(view.container, ".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "60% of context window used");
  assert.match(usage.textContent, /120K \/ 200K tokens used/);

  const settings = view.container.querySelectorAll<HTMLDetailsElement>(".composer-settings .setting-menu");
  assert.equal(settings.length, 3, "permission mode, model, and effort");
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
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Complete agent details"]').click(); });
  assert.ok(view.container.querySelector(".subagent-inspector"));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Close subagent details"]').click(); });
  assert.ok(view.container.querySelector('.agents-panel button[aria-label="Open Complete agent details"]'));

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
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Complete agent details"]').click(); });
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
  const labels = [...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button:not([disabled])")].map((button) => button.getAttribute("aria-label"));
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
