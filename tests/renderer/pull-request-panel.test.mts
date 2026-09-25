import { dom, mount, query, item } from "../support/renderer-dom.mts";
import assert from "node:assert/strict";

import React, { act } from "react";

import { test } from "vitest";
import type { PullRequestAnswer, PullRequestState } from "../../src/domain/pull-request.ts";
import { NO_PULL_REQUEST } from "../../src/domain/pull-request.ts";
import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";
import { OPEN_SUBAGENT_GROUPS } from "../../src/domain/run.ts";

const { MessageLinkProvider } = await import("../../src/renderer/components/MarkdownMessage.tsx");
const { SessionPanel } = await import("../../src/renderer/components/SessionPanel.tsx");
const { usePullRequestReads } = await import("../../src/renderer/task-workspace/pull-request-reads.ts");

function renderSessionPanel(overrides: Partial<SessionPanelProps>) {
  return React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "pr-chip", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    pullRequest: NO_PULL_REQUEST,
    openMenu: null,
    subagents: [],
    subagentGroups: OPEN_SUBAGENT_GROUPS,
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
    onSetSubagentGroup() {},
    onCheckoutBranch() {},
    ...overrides,
  });
}

test("the session panel names the pull request the checkout belongs to, and only when there is one", async () => {
  const opened: string[] = [];
  const panel = (pullRequest: PullRequestAnswer) => React.createElement(MessageLinkProvider, {
    actions: { openUrlInApp: (url: string) => { opened.push(url); } },
    children: renderSessionPanel({ workspaceId: "workspace-a", pullRequest }),
  });

  const view = await mount(panel(NO_PULL_REQUEST));
  assert.equal(view.container.querySelector(".session-pull-request"), null, "no pull request is no row at all");

  await view.render(panel({ status: "found", pullRequest: { number: 12, title: "Name the two families", url: "https://github.com/o/r/pull/12", state: "merged" } }));
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
  const view = await mount(renderSessionPanel({ workspaceId: "workspace-without-gh", pullRequest: { status: "gh-missing" } }));
  const row = query<HTMLAnchorElement>(view.container, ".session-pull-request");
  assert.match(row.textContent, /Install gh/);
  assert.equal(row.getAttribute("href"), "https://cli.github.com");
  await view.unmount();
});

test("the pull request is read per thread, on the way back, and only until it settles", async () => {
  let reads = 0;

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

  const read = () => { reads += 1; };
  function Reader({ threadId, answer }: { threadId: string; answer: PullRequestAnswer }) {
    usePullRequestReads("one-checkout", "pr-poll", threadId, answer, read);
    return null;
  }
  const reader = (threadId: string, answer: PullRequestAnswer) => React.createElement(Reader, { threadId, answer });
  const found = (state: PullRequestState): PullRequestAnswer => ({ status: "found", pullRequest: { number: 7, title: "Poll me", url: "https://github.com/o/r/pull/7", state } });

  const view = await mount(reader("thread-a", NO_PULL_REQUEST));
  try {
    assert.equal(reads, 1);
    assert.deepEqual([...timers.values()].map((timer) => timer.ms), [60_000], "one poll, slow enough to be worth its network");

    /** Threads sharing a checkout share a workspace and a branch, so neither one changing would ask again. */
    await view.render(reader("thread-b", NO_PULL_REQUEST));
    assert.equal(reads, 2, "moving to another thread in the same checkout asks again");

    await poll();
    assert.equal(reads, 3, "a pull request made outside the app is found by the poll");

    await view.render(reader("thread-b", found("open")));
    await poll();
    assert.equal(reads, 4, "an open pull request is still worth asking about");

    await view.render(reader("thread-b", found("merged")));
    assert.deepEqual([...timers.values()], [], "a settled pull request is left with no poll at all");

    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(reads, 5, "coming back to the window still asks once, which is what catches a reopen");
  } finally {
    dom.window.setInterval = realInterval;
    dom.window.clearInterval = realClear;
    await view.unmount();
  }
});
