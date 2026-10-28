import { fakeDesktop } from "../support/desktop-api.mts";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { Thread } from "../../src/domain/thread.ts";
import type { AppCommand } from "../../src/contracts/commands.ts";
import type { CoordinatedThreadView } from "../../src/application/coordination-view.ts";
import { dom, mount, query } from "../support/renderer-dom.mts";

const { ThreadCards, ThreadCardsContext } = await import("../../src/renderer/components/Coordination.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

const member = (id: string, title: string, overrides: Partial<Thread> = {}): Thread => ({
  id, title, engine: "claude", executionPolicy: "allow-edits", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, parentId: "lead", ...overrides,
});

const PULL_REQUEST = { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix login", state: "open" as const, checks: "failing" as const };

const failing: CoordinatedThreadView = {
  thread: member("fix", "Fix login", { worktreeId: "wt-1" }),
  status: "needs-work",
  summary: "#212 · Checks failing",
  pullRequest: PULL_REQUEST,
  steps: ["fix-ci"],
  startedAt: 10,
  host: null,
  lastHeard: false,
};

const working: CoordinatedThreadView = { thread: member("dark", "Dark mode", { engine: "codex" }), status: "working", summary: "Tokens pass", pullRequest: null, steps: [], startedAt: 10, host: null, lastHeard: false };

test("a card shows how its thread stands, opens it, and offers what to do next beside that", async () => {
  window.desktop = fakeDesktop();
  const selected: string[] = [];
  const dispatched: AppCommand[] = [];
  const worktree = { id: "wt-1", name: "fix-login", projectId: "p", root: "/tmp/wt-1", workspaceId: "ws-1", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 };
  const cards = (available: boolean) => React.createElement(CommandControlsProvider, { value: { available: (command: AppCommand) => available || command.type !== "coordination.next-step", dispatch: (command: AppCommand) => { dispatched.push(command); } } },
    React.createElement(ThreadCardsContext.Provider, {
      value: {
        cards: new Map([[failing.thread.id, failing], [working.thread.id, working]]),
        worktrees: new Map([[worktree.id, worktree]]),
        onSelect: (id: string) => { selected.push(id); },
      },
    }, React.createElement(ThreadCards, { threadIds: ["fix", "gone", "dark"] })));
  const view = await mount(cards(true));
  const shown = [...view.container.querySelectorAll<HTMLElement>(".coordination-card")];
  assert.equal(shown.length, 2, "a thread no longer under the coordinator draws no card");

  const [fix, dark] = shown as [HTMLElement, HTMLElement];
  assert.match(query(fix, ".coordination-card-open > small").textContent, /^Needs work$/, "a pull request with something to fix is not ready for review");
  assert.doesNotMatch(query(fix, ".coordination-card-open > small").textContent, /#212/, "the pull request is said once, by its chip");
  assert.equal(query(fix, ".coordination-card-pull-request").textContent, "#212 · Checks failing");
  assert.equal(query(fix, ".coordination-card-pull-request").title, "#212 · Checks failing", "a line the chip clips is said whole on hover");
  assert.equal(query(fix, ".coordination-card-pull-request > span").textContent, "#212 · Checks failing", "in a box of its own, which the chip's ellipsis clips");
  assert.ok(query(fix, '[aria-label="Works in fix-login"]'), "a thread in a worktree carries its mark");
  assert.equal(query(dark, ".coordination-card-open > small").textContent, "Working · Tokens pass");
  assert.equal(query(dark, ".coordination-card-open > small").className, "text-sweep", "a working thread's status moves");
  assert.equal(dark.querySelector(".coordination-card-steps"), null, "a working thread is offered nothing");

  const description = (card: HTMLElement) => (query(card, ".coordination-card-open").getAttribute("aria-describedby") ?? "").split(" ").map((id) => dom.window.document.getElementById(id)?.textContent);
  assert.deepEqual(description(fix), ["Needs work", "#212 · Checks failing"], "a card is read with how its thread stands and its pull request's, not just its name");
  assert.deepEqual(description(dark), ["Working · Tokens pass"]);
  await act(async () => { query<HTMLButtonElement>(fix, 'button[aria-label="Open Fix login"]').click(); });
  assert.deepEqual(selected, ["fix"]);

  const step = [...fix.querySelectorAll<HTMLButtonElement>("button.coordination-card-step")];
  assert.deepEqual(step.map((button) => button.textContent), ["Fix CI"]);
  assert.deepEqual(step.map((button) => button.getAttribute("aria-label")), ["Fix CI for Fix login"], "a step names the thread it is for, as Resolve does");
  assert.equal(step[0]!.closest(".coordination-card-open"), null, "a step sits beside the open button, never inside it");
  await act(async () => { step[0]!.click(); });
  assert.deepEqual(dispatched, [{ type: "coordination.next-step", taskId: "fix", step: "fix-ci" }]);

  const review = query<HTMLAnchorElement>(fix, "a.coordination-card-step");
  assert.equal(review.textContent, "Review PR");
  assert.equal(review.getAttribute("aria-label"), "Review PR for Fix login", "its name starts with what it shows, as voice control says it");
  assert.equal(review.href, PULL_REQUEST.url);
  assert.equal(review.closest(".coordination-card-open"), null);

  await view.render(cards(false));
  const unavailable = query<HTMLButtonElement>(view.container, "button.coordination-card-step");
  assert.equal(unavailable.getAttribute("aria-disabled"), "true", "a computer whose build cannot take a step offers none");
  dispatched.length = 0;
  await act(async () => { unavailable.click(); });
  assert.deepEqual(dispatched, []);
  await view.unmount();
});

test("a card asks for a review only while its pull request can still change", async () => {
  window.desktop = fakeDesktop();
  const settled = (state: "merged" | "closed"): CoordinatedThreadView => ({ ...failing, status: "resolved", summary: null, pullRequest: { ...PULL_REQUEST, state }, steps: [] });
  const card = (shown: CoordinatedThreadView) => React.createElement(ThreadCardsContext.Provider, { value: { cards: new Map([[shown.thread.id, shown]]), worktrees: new Map(), onSelect: () => {} } }, React.createElement(ThreadCards, { threadIds: ["fix"] }));
  const view = await mount(card(settled("merged")));
  assert.equal(query<HTMLAnchorElement>(view.container, "a.coordination-card-step").textContent, "View PR", "a merged pull request is only there to read");
  await view.render(card(settled("closed")));
  assert.equal(query<HTMLAnchorElement>(view.container, "a.coordination-card-step").textContent, "View PR");
  await view.render(card({ ...failing, pullRequest: { ...PULL_REQUEST, state: "draft" } }));
  assert.equal(query<HTMLAnchorElement>(view.container, "a.coordination-card-step").textContent, "Review PR", "a draft can still change");
  await view.unmount();
});

test("a thread working as a computer out of reach last said says so, and moves no more", async () => {
  window.desktop = fakeDesktop();
  const away = { ...working, host: { id: "studio", name: "studio", offline: true }, lastHeard: true };
  const view = await mount(React.createElement(ThreadCardsContext.Provider, { value: { cards: new Map([[away.thread.id, away]]), worktrees: new Map(), onSelect: () => {} } }, React.createElement(ThreadCards, { threadIds: ["dark"] })));
  const card = query(view.container, ".coordination-card");
  assert.equal(query(card, ".coordination-card-open > small").textContent, "Working when last heard · Tokens pass");
  assert.equal(query(card, ".coordination-card-open > small").className, "");
  assert.equal(card.querySelector(".task-spinner"), null);
  assert.ok(query(card, ".coordination-dot.working"));
  await view.unmount();
});

test("each next step is read by what it shows, then the thread it is for", async () => {
  window.desktop = fakeDesktop();
  const every: CoordinatedThreadView = { ...failing, pullRequest: null, steps: ["resolve-conflicts", "fix-ci", "address-comments", "merge", "create-pull-request"] };
  const view = await mount(React.createElement(ThreadCardsContext.Provider, { value: { cards: new Map([["fix", every]]), worktrees: new Map(), onSelect() {} } }, React.createElement(ThreadCards, { threadIds: ["fix"] })));
  assert.deepEqual([...view.container.querySelectorAll("button.coordination-card-step")].map((button) => button.getAttribute("aria-label")), [
    "Resolve conflicts in Fix login's pull request", "Fix CI for Fix login", "Address comments on Fix login's pull request", "Merge it: Fix login's pull request", "Create PR for Fix login",
  ]);
  const shown = [...view.container.querySelectorAll("button.coordination-card-step")].map((button) => [button.textContent ?? "", button.getAttribute("aria-label") ?? ""]);
  assert.ok(shown.every(([label, name]) => name.startsWith(label)), "every name starts with its visible label");
  await view.unmount();
});

test("cards outside a coordinator's own transcript draw nothing", async () => {
  const view = await mount(React.createElement(ThreadCards, { threadIds: ["fix"] }));
  assert.equal(view.container.innerHTML, "");
  await view.unmount();
});

test("a next step taken from the keyboard hands focus to its card once the step is gone", async () => {
  window.desktop = fakeDesktop();
  const cards = (views: CoordinatedThreadView[]) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch() {} } },
    React.createElement(ThreadCardsContext.Provider, { value: { cards: new Map(views.map((view) => [view.thread.id, view])), worktrees: new Map(), onSelect() {} } },
      React.createElement(ThreadCards, { threadIds: ["fix", "dark"] })));
  const focused = () => dom.window.document.activeElement?.getAttribute("aria-label") ?? "the page";
  const view = await mount(cards([failing, working]));
  await act(async () => { const step = query<HTMLButtonElement>(view.container, ".coordination-card-step"); step.focus(); step.click(); });
  await view.render(cards([{ ...failing, status: "working", steps: [] }, working]));
  assert.equal(focused(), "Open Fix login", "a step taken up hands focus to its own card");

  await view.render(cards([failing, working]));
  await act(async () => { const step = query<HTMLButtonElement>(view.container, ".coordination-card-step"); step.focus(); step.click(); });
  await view.render(cards([working]));
  assert.equal(focused(), "Open Dark mode", "a card gone with it hands focus to the card that took its place");
  await view.unmount();
});

test("a card's pull request chip is held to the card, so its ellipsis clips a long line rather than the card", async () => {
  /** jsdom lays nothing out; the open area is a grid whose one column grows to whatever an item will not shrink below. */
  const css = await readFile(new URL("../../src/renderer/components/coordination.css", import.meta.url), "utf8");
  const chip = css.match(/\.coordination-card-pull-request \{([^}]*)\}/)?.[1] ?? "";
  assert.match(chip, /min-width: 0;/);
  assert.match(css, /\.coordination-card-pull-request > span \{[^}]*text-overflow: ellipsis;/);
});
