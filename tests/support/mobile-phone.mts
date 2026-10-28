import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MobileClientMessage, MobilePatch, MobileView } from "../../src/contracts/mobile.ts";
import { MOBILE_CREDENTIAL_KEY, MOBILE_FOLDED_KEY } from "../../src/mobile/client/storage.ts";
import { App } from "../../src/mobile/App.tsx";

/** The phone page in a DOM, on a fake socket a test answers as the Mac would. */
export const CODE = "K7M2P9QX";
export const BUILD = "b7f0c1d2e3a4b5c6";
export const TOKEN = "b".repeat(64);

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://mac.ts.net/m#pair=${CODE}` });
for (const name of ["window", "document", "localStorage", "history", "location", "navigator", "Element", "Node", "HTMLElement", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: () => {} });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
/** No animation frames run here, so the sheet is asked to leave the way it does under reduced motion. */
Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }) });

/** Every socket the page opens, so a test can answer as the Mac would. */
const lines: FakeSocket[] = [];

export class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: MobileClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    lines.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });

export function view(): MobileView {
  return {
    groups: [{ projectId: "p", name: "App", threads: [{ id: "t1", title: "Fix the parser", projectId: "p", projectName: "App", attention: false, status: "awaiting-approval", lastActivityAt: Date.now(), unread: true }] }],
    activity: { priority: [], running: [], threads: [], snoozed: [] }, theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" },
    thread: {
      id: "t1",
      title: "Fix the parser",
      projectId: "p",
      projectName: "App",
      worktreeId: null,
      messages: [
        { kind: "user", text: "please fix", at: 1 },
        { kind: "tool", text: "Bash", at: 2 },
        { kind: "tool", text: "Bash", at: 3 },
        { kind: "assistant", text: "## Done\n\n- one\n- two", at: 4 },
      ],
      omitted: 3,
      streamingTail: null,
      status: "awaiting-approval",
      approval: { taskId: "t1", approvalId: "a1", runId: "r1", title: "Run a command", description: "rm -rf build", toolName: "Bash", detail: "{}" },
      queued: [{ id: "q1", text: "then deploy" }],
      settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" },
      location: { kind: "local" },
      worktrees: [],
      canMove: true,
      changes: null,
      reviewable: true,
      branchRange: { kind: "branches", base: "HEAD", compare: null },
    },
    draft: null,
    error: null,
    undo: null,
  };
}

/** The command carried by the newest frame, which is what a tap is supposed to have produced. */
export function lastCommand(line: FakeSocket) {
  const frame = line.sent.at(-1);
  return frame?.kind === "command" ? frame.command : null;
}

/** React reads the value off the node, so a keystroke is the native setter plus the event it raises. */
export function typeInto(selector: string, text: string) {
  const node = document.querySelector(selector);
  assert.ok(node, `no ${selector}`);
  const setter = Object.getOwnPropertyDescriptor((node instanceof dom.window.HTMLInputElement ? dom.window.HTMLInputElement : dom.window.HTMLTextAreaElement).prototype, "value")?.set;
  assert.ok(setter);
  act(() => {
    setter.call(node, text);
    node.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
}

/**
 * A fresh page on a stated footing: a pairing code in the address, or a device already paired, or
 * neither. The page reads both once on mount, so a test that leaves them to a neighbour is reading
 * that neighbour's leftovers.
 */
export function openPhone({ code = null, paired = false, folded = [] }: { code?: string | null; paired?: boolean; folded?: string[] } = {}): FakeSocket {
  localStorage.clear();
  if (paired) localStorage.setItem(MOBILE_CREDENTIAL_KEY, JSON.stringify({ token: TOKEN, deviceId: "d1", deviceName: "Phone" }));
  if (folded.length) localStorage.setItem(MOBILE_FOLDED_KEY, JSON.stringify(folded));
  window.history.replaceState(null, "", code ? `/m#pair=${code}` : "/m");
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  act(() => void createRoot(host).render(React.createElement(App)));
  const line = lines.at(-1);
  assert.ok(line, "the page opened no socket");
  return line;
}

export function click(selector: string) {
  const node = document.querySelector(selector);
  assert.ok(node, `no ${selector}`);
  act(() => void node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

/** The button whose words are `text`, as a thumb finds it. */
export function clickButton(text: string, within = "body") {
  const node = [...document.querySelectorAll(`${within} button`)].find((button) => button.textContent === text);
  assert.ok(node, `no button ${text}`);
  act(() => void node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

/** Taps the menu row whose label starts with `text`, inside React's own turn. */
export function clickRow(text: string) {
  const row = [...document.querySelectorAll<HTMLButtonElement>(".menu-row")].find((node) => node.textContent?.startsWith(text));
  assert.ok(row, `no menu row ${text}`);
  act(() => void row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

/** The frames the phone has asked the Mac to read, newest last. */
export function queries(line: FakeSocket) {
  return line.sent.flatMap((frame) => frame.kind === "query" ? [frame] : []);
}

export function live(line: FakeSocket, body: MobileView = view()) {
  act(() => line.onopen?.());
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s9", build: BUILD, view: body }) }));
}

/** A change the Mac pushes after the snapshot `live` sent, numbered `sequence`. */
export function patchView(line: FakeSocket, sequence: number, patch: MobilePatch) {
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "patch", sequence, patch }) }));
}
