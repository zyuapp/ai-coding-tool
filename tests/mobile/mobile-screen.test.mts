import assert from "node:assert/strict";
import { test } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MobileClientMessage, MobileView } from "../../src/contracts/mobile.ts";
import { App } from "../../src/mobile/App.tsx";

const CODE = "K7M2P9QX";
const TOKEN = "b".repeat(64);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://mac.ts.net/m#pair=${CODE}` });
for (const name of ["window", "document", "localStorage", "history", "location", "navigator", "Element", "Node", "HTMLElement", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: () => {} });

/** Every socket the page opens, so a test can answer as the Mac would. */
const lines: FakeSocket[] = [];

class FakeSocket {
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

function view(): MobileView {
  return {
    groups: [{ projectId: "p", name: "App", threads: [{ id: "t1", title: "Fix the parser", status: "awaiting-approval", lastActivityAt: Date.now(), unread: true }] }],
    thread: {
      id: "t1",
      title: "Fix the parser",
      projectName: "App",
      messages: [
        { kind: "user", text: "please fix", at: 1 },
        { kind: "tool", text: "Bash", at: 2 },
        { kind: "tool", text: "Bash", at: 3 },
        { kind: "assistant", text: "## Done\n\n- one\n- two", at: 4 },
      ],
      omitted: 3,
      streamingTail: null,
      status: "awaiting-approval",
      approval: { approvalId: "a1", runId: "r1", title: "Run a command", description: "rm -rf build", toolName: "Bash", detail: "{}" },
      queued: [{ id: "q1", text: "then deploy" }],
      prompt: "",
      settings: { model: "opus", effort: "high", policy: "confirm" },
    },
    draft: null,
    error: null,
  };
}

/** The command carried by the newest frame, which is what a tap is supposed to have produced. */
function lastCommand(line: FakeSocket) {
  const frame = line.sent.at(-1);
  return frame?.kind === "command" ? frame.command : null;
}

/** React reads the value off the node, so a keystroke is the native setter plus the event it raises. */
function typeInto(selector: string, text: string) {
  const node = document.querySelector(selector);
  assert.ok(node, `no ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(setter);
  act(() => {
    setter.call(node, text);
    node.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
}

function click(selector: string) {
  const node = document.querySelector(selector);
  assert.ok(node, `no ${selector}`);
  act(() => void node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

test("the phone page pairs from the address, opens a thread, and answers an approval", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => void createRoot(host).render(React.createElement(App)));

  const line = lines[0]!;
  assert.equal(line.url, "wss://mac.ts.net/m/socket");
  /** The code is out of the address before anything else, so a reload cannot try to spend it twice. */
  assert.equal(window.location.hash, "");

  act(() => line.onopen?.());
  assert.deepEqual(line.sent[0], { kind: "pair", version: 1, code: CODE, deviceName: "Phone" });

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "paired", sequence: 1, deviceId: "d1", deviceName: "Phone", token: TOKEN });
  receive({ kind: "snapshot", sequence: 2, sessionId: "s1", view: view() });

  assert.match(document.body.textContent ?? "", /Fix the parser/);
  assert.match(document.body.textContent ?? "", /Needs you/);

  click(".thread-row");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });

  const text = document.body.textContent ?? "";
  assert.match(text, /3 earlier messages are only on the Mac/);
  /** Two calls of the same tool are one row with a count, not two rows saying "Bash". */
  assert.match(text, /Bash ×2/);
  assert.match(text, /then deploy/);
  assert.equal(document.querySelectorAll(".markdown li").length, 2);

  click(".approval-actions .allow");
  assert.deepEqual(lastCommand(line), { type: "run.decide", taskId: "t1", allow: true });

  click(".composer-settings");
  assert.ok(document.querySelector(".sheet"));
  click(".sheet-option");
  assert.deepEqual(lastCommand(line), { type: "task.set-policy", taskId: "t1", policy: "autonomous" });
});

test("the phone shows the thread the Mac actually has open, and says what went wrong", () => {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  act(() => void createRoot(host).render(React.createElement(App)));

  const line = lines.at(-1)!;
  act(() => line.onopen?.());
  assert.equal(line.sent[0]?.kind, "resume", "the token from the last page got it back in without a code");

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "snapshot", sequence: 1, sessionId: "s2", view: view() });
  click(".thread-row");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });

  /** Somebody at the Mac opened a different thread. The phone follows rather than waiting for its own. */
  const elsewhere = view();
  elsewhere.thread = { ...elsewhere.thread!, id: "t2", title: "Rewrite the docs", approval: null, queued: [] };
  receive({ kind: "snapshot", sequence: 2, sessionId: "s2", view: elsewhere });
  assert.match(document.body.textContent ?? "", /Rewrite the docs/);
  assert.doesNotMatch(document.body.textContent ?? "", /Opening the thread/);

  receive({ kind: "patch", sequence: 3, patch: { error: "That worktree is busy." } });
  assert.match(document.querySelector(".banner")?.textContent ?? "", /That worktree is busy/);
});

test("New opens the thread the Mac is about to start, and the first message starts it", () => {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  act(() => void createRoot(host).render(React.createElement(App)));

  const line = lines.at(-1)!;
  act(() => line.onopen?.());

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "snapshot", sequence: 1, sessionId: "s3", view: view() });

  click(".group-header .ghost");
  assert.deepEqual(lastCommand(line), { type: "task.new", projectId: "p" });

  /** The Mac has no thread open from here until a message makes one, which is what it answers with. */
  const draft = { projectName: "App", prompt: "", settings: { model: "opus" as const, effort: "high" as const, policy: "confirm" as const } };
  receive({ kind: "patch", sequence: 2, patch: { thread: { kind: "closed" }, draft } });
  assert.match(document.body.textContent ?? "", /Say what this thread is for/);
  assert.doesNotMatch(document.body.textContent ?? "", /Opening the thread/);

  click(".composer-settings");
  click(".sheet-option");
  assert.deepEqual(lastCommand(line), { type: "task.set-policy", policy: "autonomous" }, "a thread yet to exist has no id to name");
  click(".sheet .primary");

  typeInto(".composer-field textarea", "start here");
  click(".round.send");
  assert.deepEqual(line.sent.slice(-2).map((frame) => frame.kind === "command" ? frame.command : null), [
    { type: "view.set-prompt", prompt: "start here" },
    { type: "task.send" },
  ]);

  /** The send made the thread, and the Mac opening it is what takes the phone off the draft. */
  receive({ kind: "patch", sequence: 3, patch: { thread: { kind: "opened", thread: view().thread! }, draft: null } });
  assert.match(document.body.textContent ?? "", /Fix the parser/);
});
