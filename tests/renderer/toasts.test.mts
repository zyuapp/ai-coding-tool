import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { App } from "../../src/renderer/App.tsx";
import { mount, query } from "../support/renderer-dom.mts";

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
