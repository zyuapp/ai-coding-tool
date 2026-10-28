import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { App } from "../../src/renderer/App.tsx";
import { mount, query } from "../support/renderer-dom.mts";
import { seedProjectTasks } from "../support/sidebar.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

test("the first launch after an update shows a toast in the corner, and its X takes it away", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop({ launchedUpdate: async () => "0.8.0" });
  const view = await mount(React.createElement(App));
  await act(async () => {});
  const toast = query(view.container, ".toasts .toast.success");
  assert.match(toast.textContent ?? "", /AI Coding Tool updated/);
  assert.match(toast.textContent ?? "", /Now on 0\.8\.0\./);
  await act(async () => { query<HTMLButtonElement>(toast, 'button[aria-label="Dismiss"]').click(); });
  assert.equal(view.container.querySelector(".toasts"), null);
  await view.unmount();
});

test("dismissing a Priority row files it away with no toast", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet", updatedAt: 1 },
    { id: "waiting", title: "Review me", updatedAt: 2, outcome: "finished" },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]').click(); });
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss Review me"]').click(); });
    assert.equal(view.container.querySelector('nav[aria-label="Priority"] .task-row'), null);
    assert.equal(view.container.querySelector(".toasts"), null);
  } finally { await view.unmount(); }
});

test("a command in a toast reads as code and wraps only between its words", async () => {
  const { Toasts } = await import("../../src/renderer/components/Toasts.tsx");
  const view = await mount(React.createElement(Toasts, {
    toasts: [{ id: 1, tone: "error", title: "Couldn't update Codex", message: "EACCES. Run `npm install -g @openai/codex@latest` in your terminal." }],
    onDismiss: () => {},
    onAction: () => {},
  }));
  const code = query(view.container, ".toast.error code");
  assert.equal(code.textContent, "npm install -g @openai/codex@latest");
  assert.deepEqual([...code.querySelectorAll("span")].map((word) => word.textContent), ["npm", "install", "-g", "@openai/codex@latest"]);
  assert.equal(query(view.container, ".toast.error").getAttribute("role"), "alert");
  await view.unmount();
});

test("an offer's button sends its command, and the offer has no timer to beat", async () => {
  const { Toasts } = await import("../../src/renderer/components/Toasts.tsx");
  const sent: unknown[] = [];
  const view = await mount(React.createElement(Toasts, {
    toasts: [{ id: 1, tone: "update", title: "Codex 0.160.2 is available", message: "You have 0.160.1.", persistent: true, action: { label: "Upgrade", command: { type: "engine.update", engine: "codex" } } }],
    onDismiss: () => {},
    onAction: (command: unknown) => { sent.push(command); },
  }));
  await act(async () => { query<HTMLButtonElement>(view.container, ".toast.update .toast-action").click(); });
  assert.deepEqual(sent, [{ type: "engine.update", engine: "codex" }]);
  await view.unmount();
});

test("a card whose time runs out stays while the pointer or the caret is on the cards, and leaves once both have left", async () => {
  const { Toasts } = await import("../../src/renderer/components/Toasts.tsx");
  const pushed = { id: 1, tone: "success" as const, title: "Pushed" };
  const failed = { id: 2, tone: "error" as const, title: "Couldn't push", message: "Run `git pull` first." };
  const props = { onDismiss: () => {}, onAction: () => {} };
  const view = await mount(React.createElement(Toasts, { ...props, toasts: [pushed, failed] }));
  const titles = () => [...view.container.querySelectorAll(".toast strong")].map((title) => title.textContent);
  const toast = query(view.container, ".toast");
  try {
    await act(async () => { toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    await view.render(React.createElement(Toasts, { ...props, toasts: [pushed] }));
    assert.deepEqual(titles(), ["Couldn't push", "Pushed"], "the pointer keeps the card that ran out");

    const close = query<HTMLButtonElement>(view.container, ".toast-close");
    await act(async () => close.focus());
    await act(async () => { toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    assert.deepEqual(titles(), ["Couldn't push", "Pushed"], "the caret still keeps it");

    await act(async () => close.blur());
    assert.deepEqual(titles(), ["Pushed"], "letting go takes it away");
  } finally { await view.unmount(); }
});

test("closing a held card takes it away even though its time already ran out", async () => {
  const { Toasts } = await import("../../src/renderer/components/Toasts.tsx");
  const dismissed: number[] = [];
  const pushed = { id: 1, tone: "success" as const, title: "Pushed" };
  const failed = { id: 2, tone: "error" as const, title: "Couldn't push" };
  const props = { onDismiss: (id: number) => { dismissed.push(id); }, onAction: () => {} };
  const view = await mount(React.createElement(Toasts, { ...props, toasts: [pushed, failed] }));
  const titles = () => [...view.container.querySelectorAll(".toast strong")].map((title) => title.textContent);
  try {
    await act(async () => { query(view.container, ".toast").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    await view.render(React.createElement(Toasts, { ...props, toasts: [pushed] }));
    await act(async () => { query<HTMLButtonElement>(view.container, ".toast.error .toast-close").click(); });
    assert.deepEqual(dismissed, [2]);
    assert.deepEqual(titles(), ["Pushed"]);
  } finally { await view.unmount(); }
});

test("Escape on a card closes it and hands the caret to the next card; Escape elsewhere leaves the cards", async () => {
  const { Toasts } = await import("../../src/renderer/components/Toasts.tsx");
  const dismissed: number[] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(React.createElement(Toasts, {
    toasts: [{ id: 1, tone: "success", title: "Pushed" }, { id: 2, tone: "error", title: "Couldn't push" }],
    onDismiss: (id: number) => { dismissed.push(id); },
    onAction: () => {},
  }));
  try {
    const [newest, older] = [...view.container.querySelectorAll<HTMLElement>(".toast")];
    outside.focus();
    await act(async () => { outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.deepEqual(dismissed, []);

    const close = query<HTMLButtonElement>(newest!, ".toast-close");
    close.focus();
    await act(async () => { close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.deepEqual(dismissed, [2]);
    assert.equal(document.activeElement, query(older!, ".toast-close"));

    await act(async () => { query<HTMLButtonElement>(older!, ".toast-close").click(); });
    assert.deepEqual(dismissed, [2, 1]);
    assert.equal(document.activeElement, query(newest!, ".toast-close"), "clicking X keeps the caret on the cards that remain");
  } finally { outside.remove(); await view.unmount(); }
});
