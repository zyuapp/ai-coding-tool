import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, test } from "vitest";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { PullRequestAnswer } from "../../src/domain/pull-request.ts";
import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** jsdom has no animation frames, and the focus a closing menu puts back is queued on one. */
const frames = {
  requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
};
for (const target of [globalThis, dom.window]) {
  for (const [name, value] of Object.entries(frames)) Object.defineProperty(target, name, { configurable: true, value });
}

const { MessageLinkProvider } = await import("../../src/renderer/components/MarkdownMessage.tsx");
const { SessionPanel } = await import("../../src/renderer/components/SessionPanel.tsx");

afterAll(() => {
  dom.window.close();
});

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function item<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

/** The two answers the panel asks for. Everything else it draws comes in as a property. */
function fakeDesktop() {
  const desktop = {
    branches: async () => ({ status: "available", branches: ["main"], remotes: [], current: "main" }) as const,
    pullRequest: async (): Promise<PullRequestAnswer> => ({ status: "none" }),
  };
  window.desktop = desktop as unknown as DesktopAPI;
  return desktop;
}

function renderSessionPanel(overrides: Partial<SessionPanelProps>) {
  return React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "pr-chip", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    location: { kind: "local" },
    runActive: false,
    openMenu: null,
    subagents: [],
    backgroundProcesses: [],
    workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAgents() {},
    onOpenAutomations() {},
    onToggleChanges() {},
    onOpenWorkflow() {},
    onStopProcess() {},
    onSetOpenMenu() {},
    onSetWorktree() {},
    onCheckoutBranch() {},
    ...overrides,
  });
}

test("the session panel names the pull request the checkout belongs to, and only when there is one", async () => {
  const desktop = fakeDesktop();
  const opened: string[] = [];
  const panel = (workspaceId: string) => React.createElement(MessageLinkProvider, {
    actions: { openUrlInApp: (url: string) => { opened.push(url); } },
    children: renderSessionPanel({ workspaceId }),
  });

  const view = await mount(panel("workspace-without-pr"));
  assert.equal(view.container.querySelector(".session-pull-request"), null, "no pull request is no row at all");

  desktop.pullRequest = async () => ({ status: "found", pullRequest: { number: 12, title: "Name the two families", url: "https://github.com/o/r/pull/12", state: "merged" } });
  await view.render(panel("workspace-with-pr"));
  const row = query<HTMLAnchorElement>(view.container, ".session-pull-request");
  assert.match(row.textContent, /#12/, "the row says which pull request the work belongs to");
  assert.match(item(row.getAttribute("title")), /Name the two families/);
  assert.equal(query<HTMLElement>(row, ".session-row-icon").dataset.state, "merged", "the icon carries the state");
  assert.equal(row.getAttribute("href"), "https://github.com/o/r/pull/12");
  assert.equal(row.getAttribute("target"), "_blank", "a click leaves AI Coding Tool the way any other link does");

  await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
  await act(async () => { item([...document.querySelectorAll<HTMLButtonElement>(".context-menu-popover button")].find((element) => /Open in AI Coding Tool/.test(element.textContent))).click(); });
  assert.deepEqual(opened, ["https://github.com/o/r/pull/12"], "its context menu offers the browser panel instead");
  await view.unmount();
});

test("a checkout on GitHub with no gh is told to install it rather than left blank", async () => {
  const desktop = fakeDesktop();
  desktop.pullRequest = async () => ({ status: "gh-missing" });

  const view = await mount(renderSessionPanel({ workspaceId: "workspace-without-gh" }));
  const row = query<HTMLAnchorElement>(view.container, ".session-pull-request");
  assert.match(row.textContent, /Install gh/);
  assert.equal(row.getAttribute("href"), "https://cli.github.com");
  await view.unmount();
});

test("the pull request is read per thread, on the way back, and only until it settles", async () => {
  const desktop = fakeDesktop();
  let reads = 0;
  let answer: PullRequestAnswer = { status: "none" };
  desktop.pullRequest = async () => { reads += 1; return answer; };

  /** The poll is jsdom's own interval, so it is held here rather than waited out. */
  const timers = new Map<number, { fn: () => void; ms: number | undefined }>();
  const { setInterval: realInterval, clearInterval: realClear } = dom.window;
  let nextTimer = 0;
  dom.window.setInterval = (fn: TimerHandler, ms?: number) => {
    if (typeof fn !== "function") assert.fail("The pull request poll must use a callback");
    const id = (nextTimer += 1);
    timers.set(id, { fn: () => { fn(); }, ms });
    return id;
  };
  dom.window.clearInterval = (id: number) => { timers.delete(id); };
  const poll = async () => { for (const timer of [...timers.values()]) await act(async () => { timer.fn(); }); };

  const panel = (taskId: string) => renderSessionPanel({
    environment: { status: "available", files: [], branch: "pr-poll", baseline: null, additions: 0, deletions: 0 },
    workspaceId: "one-checkout",
    taskId,
  });
  const state = () => view.container.querySelector<HTMLElement>(".session-pull-request .session-row-icon")?.dataset.state ?? null;

  const view = await mount(panel("thread-a"));
  try {
    assert.equal(reads, 1);
    assert.deepEqual([...timers.values()].map((timer) => timer.ms), [60_000], "one poll, slow enough to be worth its network");

    /** Threads sharing a checkout share a workspace and a branch, so neither one changing would ask again. */
    await view.render(panel("thread-b"));
    assert.equal(reads, 2, "moving to another thread in the same checkout asks again");

    answer = { status: "found", pullRequest: { number: 7, title: "Poll me", url: "https://github.com/o/r/pull/7", state: "open" } };
    await poll();
    assert.equal(reads, 3, "a pull request made outside the app is found by the poll");
    assert.equal(state(), "open");

    answer = { status: "found", pullRequest: { number: 7, title: "Poll me", url: "https://github.com/o/r/pull/7", state: "merged" } };
    await poll();
    assert.equal(reads, 4);
    assert.equal(state(), "merged", "a merge nothing local could announce is still noticed");
    assert.deepEqual([...timers.values()], [], "a settled pull request is left with no poll at all");

    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(reads, 5, "coming back to the window still asks once, which is what catches a reopen");
  } finally {
    dom.window.setInterval = realInterval;
    dom.window.clearInterval = realClear;
    await view.unmount();
  }
});
