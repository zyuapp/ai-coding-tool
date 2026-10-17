import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { AppCommand } from "../../src/contracts/commands.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { ThreadProposal } from "../../src/domain/coordination.ts";
import type { CoordinationApprovalView, CoordinationDecisionView, ProposalView } from "../../src/application/coordination-view.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { required } from "../application/workspace-reducer-fixtures.mts";

const { NeedsYouCard } = await import("../../src/renderer/components/NeedsYouCard.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

const member = (id: string, title: string): Thread => ({ id, title, engine: "claude", executionPolicy: "allow-edits", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, parentId: "lead" });

test("the Needs-you card pages through approvals and decisions and answers each", async () => {
  const decided: Array<[string, boolean]> = [];
  const answered: string[] = [];
  const approval = { approvalId: "a1", taskId: "a", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "yarn test:e2e -u" } };
  const view = await mount(React.createElement(NeedsYouCard, {
    approvals: [{ thread: member("a", "Login flake"), approval }],
    decisions: [{ thread: member("b", "Settings"), decision: { id: "d1", question: "Keep the v2 reader?", options: [{ label: "Keep it", recommended: true }], raisedAt: 1 } }],
    onDecide: (item: { approvalId: string }, allow: boolean) => { decided.push([item.approvalId, allow]); },
    onAnswer: (_thread: string, _decision: string, answer: string) => { answered.push(answer); },
    onSelect() {},
  }));
  const card = query(view.container, '[aria-label="Approval waiting on you"]');
  assert.match(card.textContent, /Login flake1 of 2/);
  assert.equal(query(card, ".decision-command").textContent, "yarn test:e2e -u");
  const button = (label: string) => required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label));
  await act(async () => { button("Allow").click(); });
  await act(async () => { button("Deny").click(); });
  assert.deepEqual(decided, [["a1", true], ["a1", false]]);

  await act(async () => { button("Later").click(); });
  assert.ok(query(view.container, '[aria-label="Decision waiting on you"]'), "Later moves to the next item");
  await act(async () => { button("Decide").click(); });
  assert.deepEqual(answered, ["Keep it"]);
  await view.unmount();
});

test("the Needs-you card stays on the page the user is working in as others arrive ahead of it", async () => {
  const answered: string[] = [];
  const approval: CoordinationApprovalView = { thread: member("a", "Login flake"), approval: { approvalId: "a1", taskId: "a", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "rm -rf dist" } } };
  const decision = (id: string): CoordinationDecisionView => ({ thread: member("b", "Settings"), decision: { id, question: `Keep ${id}?`, options: [{ label: "Keep it", recommended: true }], raisedAt: 1 } });
  const request: ProposalView = { proposal: { id: "p1", title: "GPU tests", prompt: "Run them", place: { computer: { id: "studio", name: "Studio" }, worktree: false }, proposedAt: 1 }, starting: false, elsewhere: { computer: { id: "studio", name: "Studio", offline: false }, projects: [], project: null, refusal: null } };
  const card = (approvals: CoordinationApprovalView[], decisions: CoordinationDecisionView[], proposals: ProposalView[] = []) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch() {} } },
    React.createElement(NeedsYouCard, {
      approvals,
      decisions,
      suggestions: proposals.length ? { taskId: "lead", threadModel: null, proposals } : null,
      onDecide() {},
      onAnswer: (_thread: string, _decision: string, answer: string) => { answered.push(answer); },
      onSelect() {},
    }));
  const view = await mount(card([], [decision("d1")]));
  const own = query<HTMLInputElement>(view.container, 'input[aria-label="Your own answer"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    own.focus();
    item(setValue).call(own, "Drop it");
    own.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Drop it" }));
    own.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
  });

  await view.render(card([approval], [decision("d1")], [request]));
  const page = query(view.container, '[aria-label="Decision waiting on you"]');
  assert.match(page.textContent, /3 of 3/, "an approval and a request ahead of it leave the decision on screen");
  assert.equal(query<HTMLInputElement>(page, 'input[aria-label="Your own answer"]'), own, "with what was typed in it");
  assert.equal(document.activeElement, own, "and where the user was typing");
  await act(async () => { required([...page.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Decide")).click(); });
  assert.deepEqual(answered, ["Drop it"]);

  await view.render(card([approval], [decision("d2")], [request]));
  assert.match(query(view.container, '[aria-label="Decision waiting on you"]').textContent, /Keep d2\?/, "a settled page gives way to the one that takes its place");
  await view.render(card([approval], [], [request]));
  assert.match(query(view.container, '[aria-label="Run on Studio?"]').textContent, /2 of 2/, "and to the last one once nothing takes it");
  await view.unmount();
});

test("the Needs-you card keeps what the user chose or typed on a page through paging away and back", async () => {
  const dispatched: AppCommand[] = [];
  const answered: string[] = [];
  const decision = (id: string): CoordinationDecisionView => ({ thread: member("b", "Settings"), decision: { id, question: `Keep ${id}?`, options: [{ label: "Keep it", recommended: true }, { label: "Drop it" }], raisedAt: 1 } });
  const projects = [{ id: "app", root: "/code/app" }, { id: "lab", root: "/code/lab" }];
  const request: ProposalView = { proposal: { id: "p1", title: "GPU tests", prompt: "Run them", place: { computer: { id: "studio", name: "Studio" }, project: "app", worktree: false }, proposedAt: 1 }, starting: false, elsewhere: { computer: { id: "studio", name: "Studio", offline: false }, projects, project: "app", refusal: null } };
  const card = (decisions: CoordinationDecisionView[]) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: AppCommand) => { dispatched.push(command); } } },
    React.createElement(NeedsYouCard, {
      approvals: [],
      decisions,
      suggestions: { taskId: "lead", threadModel: null, proposals: [request] },
      onDecide() {},
      onAnswer: (_thread: string, _decision: string, answer: string) => { answered.push(answer); },
      onSelect() {},
    }));
  const view = await mount(card([decision("d1"), decision("d2")]));
  const button = (label: string) => required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label));
  await act(async () => {
    const folder = query<HTMLSelectElement>(view.container, ".elsewhere-folder select");
    folder.value = "lab";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLInputElement>(view.container, ".elsewhere-worktree input").click(); });
  await act(async () => { button("Later").click(); });
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    const own = query<HTMLInputElement>(view.container, 'input[aria-label="Your own answer"]');
    own.focus();
    item(setValue).call(own, "Keep it behind a flag");
    own.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Keep it behind a flag" }));
    own.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
  });
  await act(async () => { button("Later").click(); });
  await act(async () => { required([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((item) => item.value === "Drop it")).click(); });
  await act(async () => { button("Later").click(); });

  assert.match(query(view.container, '[aria-label="Run on Studio?"]').textContent, /1 of 3/);
  assert.equal(query<HTMLSelectElement>(view.container, ".elsewhere-folder select").value, "lab", "the folder picked is still picked");
  assert.equal(query<HTMLInputElement>(view.container, ".elsewhere-worktree input").checked, true, "and so is the new worktree");
  await act(async () => { button("Later").click(); });
  assert.equal(query<HTMLInputElement>(view.container, 'input[aria-label="Your own answer"]').value, "Keep it behind a flag", "the answer typed is still there");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Next"]').click(); });
  assert.equal(required([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((item) => item.checked)).value, "Drop it", "and so is the option chosen");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Previous"]').click(); });
  await act(async () => { button("Decide").click(); });
  assert.deepEqual(answered, ["Keep it behind a flag"]);

  await view.render(card([decision("d2")]));
  assert.equal(required([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((item) => item.checked)).value, "Drop it", "a page settled ahead leaves the others' drafts alone");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Previous"]').click(); });
  await act(async () => { button("Allow").click(); });
  assert.deepEqual(dispatched, [{ type: "proposal.start", taskId: "lead", proposalId: "p1", place: { project: "lab", worktree: true } }]);
  await view.unmount();
});

test("the Needs-you card's Suggested threads page starts and dismisses each suggestion, or all of them", async () => {
  const dispatched: AppCommand[] = [];
  const brief = { intent: "fix the flaky login test", doneWhen: "it passes", delivers: "pull-request" as const };
  const fix: ThreadProposal = { id: "p1", title: "Fix login", prompt: "Fix it", brief, place: { worktree: true }, model: "gpt-6-luna", proposedAt: 1 };
  const docs: ThreadProposal = { id: "p2", title: "Docs", prompt: "Write them", brief: { ...brief, intent: "write the docs" }, place: { worktree: false }, model: "opus", proposedAt: 2, error: "No project matches \"docs\"." };
  const bench: ThreadProposal = { id: "p3", title: "Bench", prompt: "Time it", brief, place: { worktree: false }, proposedAt: 3 };
  const card = (proposals: { proposal: ThreadProposal; starting: boolean }[], decisions = 0) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: AppCommand) => { dispatched.push(command); } } },
    React.createElement(NeedsYouCard, {
      approvals: [],
      decisions: Array.from({ length: decisions }, (_, index) => ({ thread: member("b", "Settings"), decision: { id: `d${index}`, question: "Keep the v2 reader?", options: [], raisedAt: 1 } })),
      suggestions: { taskId: "lead", threadModel: { model: "opus", effort: "high" }, proposals: proposals.map((view) => ({ ...view, elsewhere: null })) },
      onDecide() {},
      onAnswer() {},
      onSelect() {},
    }));
  const view = await mount(card([{ proposal: fix, starting: false }, { proposal: docs, starting: false }, { proposal: bench, starting: true }]));
  const page = query(view.container, '[aria-label="Suggested threads"]');
  const rows = [...page.querySelectorAll<HTMLElement>(".suggestion-row")];
  assert.equal(rows.length, 3);
  assert.match(rows[0]!.textContent, /Fix loginfix the flaky login testLunaWorktree/, "a model other than the threads' own and a worktree of its own are marked");
  assert.doesNotMatch(rows[1]!.textContent, /Opus|Worktree/, "the threads' own model and the shared checkout say nothing");
  assert.match(query(rows[1]!, ".suggestion-error").textContent, /No project matches "docs"/);
  assert.ok(query(rows[2]!, '[aria-label="Starting Bench"]'), "a starting row spins");
  assert.equal(rows[2]!.querySelector('[aria-label="Dismiss Bench"]'), null, "and can no longer be turned down");

  const button = (label: string) => required([...page.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label));
  await act(async () => { button("Start Fix login").click(); });
  await act(async () => { button("Dismiss Docs").click(); });
  await act(async () => { button("Start all").click(); });
  await act(async () => { button("Dismiss all").click(); });
  assert.deepEqual(dispatched, [
    { type: "proposal.start", taskId: "lead", proposalId: "p1" },
    { type: "proposal.dismiss", taskId: "lead", proposalId: "p2" },
    { type: "proposal.start", taskId: "lead" },
    { type: "proposal.dismiss", taskId: "lead" },
  ]);

  await view.render(card([{ proposal: bench, starting: true }]));
  assert.equal(button("Start all").disabled, true, "nothing is left to start while every suggestion is starting");

  await view.render(card([{ proposal: fix, starting: false }], 1));
  assert.match(query(view.container, '[aria-label="Suggested threads"]').textContent, /2 of 2/, "decisions come first, and one arriving leaves the suggestions on screen");
  await act(async () => { required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Later")).click(); });
  assert.ok(query(view.container, '[aria-label="Decision waiting on you"]'), "the decision is the page before them");
  await view.unmount();
});

test("the Needs-you card asks to run a thread on another computer, in the folder and checkout the user picks", async () => {
  const dispatched: AppCommand[] = [];
  const brief = { intent: "run the GPU tests", doneWhen: "they pass", delivers: "report" as const };
  const projects = [{ id: "app", root: "/code/app", workspaceId: "w1" }, { id: "lab", root: "/code/lab", workspaceId: "w2" }];
  const request: ThreadProposal = { id: "p1", title: "GPU tests", prompt: "Run them", brief, place: { computer: { id: "studio", name: "Studio" }, project: "app", worktree: true }, proposedAt: 1 };
  const elsewhere = (refusal: string | null = null, offline = false) => ({ computer: { id: "studio", name: "Studio", offline }, projects, project: "app", refusal });
  const card = (where = elsewhere()) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: AppCommand) => { dispatched.push(command); } } },
    React.createElement(NeedsYouCard, {
      approvals: [],
      decisions: [],
      suggestions: { taskId: "lead", threadModel: { model: "opus", effort: "high" }, proposals: [{ proposal: request, starting: false, elsewhere: where }] },
      onDecide() {},
      onAnswer() {},
      onSelect() {},
    }));
  const view = await mount(card());
  const page = query(view.container, '[aria-label="Run on Studio?"]');
  assert.match(page.textContent, /Run on Studio\?GPU tests/);
  assert.match(page.textContent, /FolderapplabNew worktree/, "the folder there and the worktree start as the coordinator asked");
  assert.ok(query(page, "details.coordination-brief"), "the brief can be read before allowing it");
  const box = query<HTMLInputElement>(page, ".elsewhere-worktree input");
  assert.equal(box.checked, true);
  const folder = query<HTMLSelectElement>(page, ".elsewhere-folder select");
  assert.equal(folder.value, "app");
  await act(async () => { folder.value = "lab"; folder.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { box.click(); });
  const button = (label: string) => required([...page.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label));
  await act(async () => { button("Allow").click(); });
  await act(async () => { button("Deny").click(); });
  assert.deepEqual(dispatched, [
    { type: "proposal.start", taskId: "lead", proposalId: "p1", place: { project: "lab", worktree: false } },
    { type: "proposal.dismiss", taskId: "lead", proposalId: "p1" },
  ]);

  for (const [refusal, offline] of [["Studio is offline.", true], ["Update AI Coding Tool on Studio to run threads there.", false]] as const) {
    await view.render(card(elsewhere(refusal, offline)));
    const allow = button("Allow");
    assert.equal(allow.disabled, true, refusal);
    assert.match(query(view.container, '[aria-label="Run on Studio?"]').textContent, new RegExp(refusal.replace(".", "\\.")));
  }
  await view.unmount();
});

test("a thread asked for on another computer starts in the folder on screen once that computer's projects arrive", async () => {
  const dispatched: AppCommand[] = [];
  const request: ThreadProposal = { id: "p1", title: "GPU tests", prompt: "Run them", place: { computer: { id: "studio", name: "Studio" }, project: "app", worktree: false }, proposedAt: 1 };
  const card = (projects: { id: string; root: string }[]) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: AppCommand) => { dispatched.push(command); } } },
    React.createElement(NeedsYouCard, {
      approvals: [],
      decisions: [],
      suggestions: {
        taskId: "lead",
        threadModel: null,
        proposals: [{ proposal: request, starting: false, elsewhere: { computer: { id: "studio", name: "Studio", offline: false }, projects, project: projects[0]?.id ?? null, refusal: projects.length ? null : "Studio is offline." } }],
      },
      onDecide() {},
      onAnswer() {},
      onSelect() {},
    }));
  const view = await mount(card([]));
  await view.render(card([{ id: "app", root: "/code/app" }, { id: "lab", root: "/code/lab" }]));
  assert.equal(query<HTMLSelectElement>(view.container, ".elsewhere-folder select").value, "app");
  await act(async () => { required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Allow")).click(); });
  assert.deepEqual(dispatched, [{ type: "proposal.start", taskId: "lead", proposalId: "p1", place: { project: "app", worktree: false } }]);
  await view.unmount();
});
