import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act, createRef } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import type { TerminalSession } from "../../src/domain/terminal.ts";
import type { BrowserTab } from "../../src/domain/browser.ts";

vi.mock("../../src/renderer/task-workspace/terminal-views.ts", () => ({
  showTerminalView: () => Promise.reject(new Error("xterm failed to load")),
  fitTerminalView: () => null,
  focusTerminalView() {},
  hideTerminalView() {},
  onTerminalInput: () => () => {},
}));

const { TerminalPanel } = await import("../../src/renderer/components/TerminalPanel.tsx");
const { DiffCommentEditor } = await import("../../src/renderer/components/DiffCommentEditor.tsx");
const { BrowserPanel } = await import("../../src/renderer/components/BrowserPanel.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

const keydown = (target: Element, key: string) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

test("removing a diff comment asks first, with the focus on Cancel, and Enter there does not send the note", async () => {
  const calls: string[] = [];
  const noteRef = createRef<HTMLTextAreaElement>();
  const view = await mount(React.createElement(DiffCommentEditor, {
    quote: "L3-L5", note: "Rename this", editing: true, noteRef,
    onNote() {}, onSubmit: () => calls.push("submit"), onClear: () => calls.push("clear"), onRemove: () => calls.push("remove"),
  }));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove comment"]').click(); });
  assert.deepEqual(calls, [], "the first press only asks");
  const cancel = dom.window.document.activeElement as HTMLButtonElement;
  assert.equal(cancel.textContent, "Cancel");
  await act(async () => { keydown(cancel, "Enter"); });
  assert.deepEqual(calls, [], "Enter on a button is the button's, not the note's");
  await act(async () => { keydown(cancel, "Escape"); });
  assert.deepEqual(calls, [], "Esc takes the question back without closing the editor");
  assert.ok(dom.window.document.activeElement === query(view.container, 'button[aria-label="Remove comment"]'));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove comment"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, "button.armed").click(); });
  assert.deepEqual(calls, ["remove"]);
  await act(async () => { const note = query<HTMLTextAreaElement>(view.container, "textarea"); note.focus(); keydown(note, "Enter"); });
  assert.deepEqual(calls, ["remove", "submit"], "Enter in the note still sends it");
  await view.unmount();
});

test("a terminal that cannot load asks before reloading the window", async () => {
  const terminal: TerminalSession = { id: "t1", title: "project", cwd: "/project", taskId: null, status: "running" };
  const view = await mount(React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch() {} } },
    React.createElement(TerminalPanel, { terminal, visible: true, onInput() {}, onResize() {} })));
  await act(async () => { await Promise.resolve(); });
  const error = query(view.container, ".terminal-error");
  assert.match(error.textContent, /xterm failed to load/);
  const ask = query<HTMLButtonElement>(error, "button");
  assert.match(ask.textContent, /Reload window/, "it names what reloads");
  await act(async () => { ask.click(); });
  assert.equal((dom.window.document.activeElement as HTMLElement).textContent, "Cancel", "the first press only asks, with the focus on Cancel");
  assert.equal(query(error, "button.armed").textContent, "Reload window");
  await act(async () => { keydown(dom.window.document.activeElement!, "Escape"); });
  assert.equal(error.querySelector("button.armed"), null, "Esc takes the question back");
  await view.unmount();
});

test("a loading page offers Stop in Reload's place when the panel can stop it", async () => {
  window.desktop = fakeDesktop();
  const calls: string[] = [];
  const tab: BrowserTab = { id: "b1", url: "https://example.com", title: "Example", loading: true, canGoBack: false, canGoForward: false } as BrowserTab;
  const panel = (props: Partial<Parameters<typeof BrowserPanel>[0]>) => React.createElement(BrowserPanel, {
    tab, approval: null, onOpen() {}, onGo() {}, onReload: () => calls.push("reload"), onDecide() {}, ...props,
  });
  const view = await mount(panel({ onStop: () => calls.push("stop") }));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop"]').click(); });
  assert.deepEqual(calls, ["stop"]);
  await view.render(panel({ tab: { ...tab, loading: false }, onStop: () => calls.push("stop") }));
  assert.equal(view.container.querySelector('button[aria-label="Stop"]'), null, "a settled page offers Reload again");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Reload"]').click(); });
  assert.deepEqual(calls, ["stop", "reload"]);
  await view.unmount();
});
