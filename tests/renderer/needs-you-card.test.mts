import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { AppCommand } from "../../src/contracts/commands.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { ThreadProposal } from "../../src/domain/coordination.ts";
import type { CoordinationApprovalView, CoordinationDecisionView, ProposalView } from "../../src/application/coordination-view.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { required } from "../application/workspace-reducer-fixtures.mts";
import { settleFrame } from "../support/settle.mts";

const { NeedsYouCard } = await import("../../src/renderer/components/NeedsYouCard.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
const { ReturnFocusContext } = await import("../../src/renderer/focus.ts");

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
  await act(async () => { button("Allow once").click(); });
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
  assert.ok(query(view.container, ".decision-options").classList.contains("overridden"), "the options show they give way to the answer typed");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Next"]').click(); });
  assert.equal(required([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((item) => item.checked)).value, "Drop it", "and so is the option chosen");
  assert.equal(query(view.container, ".decision-options").classList.contains("overridden"), false);
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
  assert.deepEqual([...query(rows[0]!, ".suggestion-text").children].map((line) => line.getAttribute("title")), ["Fix login", "fix the flaky login test"], "a title and intent the row clips are said whole on hover");
  assert.doesNotMatch(rows[1]!.textContent, /Opus|Worktree/, "the threads' own model and the shared checkout say nothing");
  assert.match(query(rows[1]!, ".suggestion-error").textContent, /No project matches "docs"/);
  assert.ok(query(rows[2]!, '[aria-label="Starting Bench"]'), "a starting row spins");
  assert.equal(rows[2]!.querySelector('[aria-label="Dismiss Bench"]'), null, "and can no longer be turned down");

  const button = (label: string) => required([...page.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label));
  await act(async () => { button("Start Fix login").click(); });
  await act(async () => { button("Dismiss Docs").click(); });
  assert.equal(dispatched.length, 1, "a suggestion is only turned down once that is confirmed");
  assert.equal(document.activeElement?.textContent, "Cancel", "the safe answer has the focus");
  await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal((document.activeElement as HTMLElement | null)?.getAttribute("aria-label"), "Dismiss Docs", "Escape backs out to the button pressed");
  assert.equal(dispatched.length, 1);
  await act(async () => { button("Dismiss Docs").click(); });
  await act(async () => { button("Dismiss").click(); });
  await act(async () => { button("Start all").click(); });
  await act(async () => { button("Dismiss all").click(); });
  assert.equal(dispatched.length, 3, "nor are they all");
  await act(async () => { required([...page.querySelectorAll<HTMLButtonElement>("button.danger")].find((item) => item.textContent === "Dismiss all")).click(); });
  assert.deepEqual(dispatched, [
    { type: "proposal.start", taskId: "lead", proposalId: "p1" },
    { type: "proposal.dismiss", taskId: "lead", proposalId: "p2" },
    { type: "proposal.start", taskId: "lead", proposalIds: ["p1", "p2"] },
    { type: "proposal.dismiss", taskId: "lead", proposalIds: ["p1", "p2"] },
  ], "Start all and Dismiss all name the suggestions on screen, never one starting, so the computer holding them acts on no other");

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
    assert.equal(allow.hasAttribute("title"), false);
    assert.equal(document.getElementById(allow.getAttribute("aria-describedby")!)?.textContent, refusal, "Allow is read with why it is off");
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

/** What holds focus, by the name it is read by, so a wrong place reads as one rather than as a whole document. */
function focusedName(): string | null {
  const active = dom.window.document.activeElement;
  return active === dom.window.document.body ? "the page" : active?.getAttribute("aria-label") ?? active?.textContent ?? null;
}

test("the Needs-you card keeps the keyboard's place as its pages turn and are answered", async () => {
  const approval: CoordinationApprovalView = { thread: member("a", "Login flake"), approval: { approvalId: "a1", taskId: "a", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "ls" } } };
  const decision = (id: string): CoordinationDecisionView => ({ thread: member(`t-${id}`, `Thread ${id}`), decision: { id, question: `Keep ${id}?`, options: [{ label: "Yes", recommended: true }], raisedAt: 1 } });
  const card = (approvals: CoordinationApprovalView[], decisions: CoordinationDecisionView[]) => React.createElement(NeedsYouCard, { approvals, decisions, onDecide() {}, onAnswer() {}, onSelect() {} });
  const view = await mount(card([approval], [decision("d1"), decision("d2")]));
  const press = async (name: string) => {
    await act(async () => {
      const pressed = required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => (item.getAttribute("aria-label") ?? item.textContent) === name));
      pressed.focus();
      pressed.click();
    });
  };

  await press("Next");
  assert.match(view.container.textContent, /2 of 3/);
  assert.equal(focusedName(), "Next", "Next hands focus to Next on the page it turned to");
  await press("Previous");
  assert.equal(focusedName(), "Previous", "so does Previous");
  await press("Later");
  assert.equal(focusedName(), "Later", "and Later");

  await press("Previous");
  await press("Allow once");
  await view.render(card([], [decision("d1"), decision("d2")]));
  assert.equal(focusedName(), "Decision waiting on you", "an answered page hands focus to the page that took its place");

  await press("Decide");
  await view.render(card([], [decision("d2")]));
  assert.equal(focusedName(), "Decision waiting on you", "so does a decided one");
  assert.match(view.container.textContent, /Keep d2\?/);

  const composer = dom.window.document.body.appendChild(dom.window.document.createElement("textarea"));
  composer.setAttribute("aria-label", "Composer");
  await press("Decide");
  await act(async () => { composer.focus(); });
  await view.render(card([], [decision("d3"), decision("d4")]));
  assert.equal(focusedName(), "Composer", "focus the user has moved on stays where it went");
  composer.remove();
  await view.unmount();
});

test("a suggestion started or dismissed from the keyboard hands focus to the row that took its place", async () => {
  const suggestion = (id: string, starting = false): ProposalView => ({ proposal: { id, title: `Suggestion ${id}`, prompt: "Do it", place: { worktree: false }, proposedAt: 1 }, starting, elsewhere: null });
  const card = (proposals: ProposalView[]) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch() {} } },
    React.createElement(NeedsYouCard, { approvals: [], decisions: [], suggestions: { taskId: "lead", threadModel: null, proposals }, onDecide() {}, onAnswer() {}, onSelect() {} }));
  const [a, b, c] = [suggestion("a"), suggestion("b"), suggestion("c")];
  const view = await mount(card([a, b, c]));
  const press = async (name: string) => {
    await act(async () => { const pressed = query<HTMLButtonElement>(view.container, `button[aria-label="${name}"]`); pressed.focus(); pressed.click(); });
  };

  await press("Dismiss Suggestion a");
  await act(async () => {
    const confirm = required([...view.container.querySelectorAll<HTMLButtonElement>("button.danger")].find((item) => item.textContent === "Dismiss"));
    confirm.focus();
    confirm.click();
  });
  await view.render(card([b, c]));
  assert.equal(focusedName(), "Dismiss Suggestion b", "a dismissed row hands focus to the same button on the row that took its place");
  await press("Start Suggestion c");
  await view.render(card([b, suggestion("c", true)]));
  assert.equal(focusedName(), "Start Suggestion b", "the last row starting hands it to the row before it");
  await press("Start Suggestion b");
  await view.render(card([suggestion("b", true), suggestion("c", true)]));
  assert.equal(focusedName(), "Suggested threads", "with nothing left to press, the page itself keeps it");
  await view.unmount();
});

test("a press the user has moved on from moves nothing when its page later changes by itself", async () => {
  const decision = (id: string): CoordinationDecisionView => ({ thread: member("b", "Settings"), decision: { id, question: `Keep ${id}?`, options: [{ label: "Keep it", recommended: true }], raisedAt: 1 } });
  const card = (decisions: CoordinationDecisionView[]) => React.createElement(NeedsYouCard, { approvals: [], decisions, onDecide() {}, onAnswer() {}, onSelect() {} });
  const view = await mount(card([]));
  for (const [how, moveOn] of [
    ["leaving the button", (from: HTMLElement) => from.blur()],
    ["pointing elsewhere", () => dom.window.document.body.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }))],
  ] as const) {
    await view.render(card([decision(`${how} 1`), decision(`${how} 2`)]));
    await act(async () => { const from = query<HTMLButtonElement>(view.container, ".decision-from"); from.focus(); from.click(); moveOn(from); });
    await view.render(card([decision(`${how} 2`)]));
    assert.equal(focusedName(), "the page", `after ${how}, a page answered elsewhere leaves focus where the user left it`);
  }
  await view.unmount();
});

test("the page the keyboard is handed is read by who asks and what, and the last one settled hands it to the composer", async () => {
  const approval = (id: string): CoordinationApprovalView => ({ thread: member(`t-${id}`, `Thread ${id}`), approval: { approvalId: id, taskId: `t-${id}`, runId: `run-${id}`, title: `Run ${id}?`, description: "Lists the folder", toolName: "Bash", input: { command: "ls" } } });
  const decision: CoordinationDecisionView = { thread: member("b", "Settings"), decision: { id: "d1", question: "Keep the v2 reader?", options: [{ label: "Keep it", recommended: true }], raisedAt: 1 } };
  const composer = { current: null as HTMLTextAreaElement | null };
  const shown = (approvals: CoordinationApprovalView[], decisions: CoordinationDecisionView[]) => React.createElement(ReturnFocusContext.Provider, { value: composer },
    React.createElement("textarea", { ref: composer, "aria-label": "Composer" }),
    approvals.length || decisions.length ? React.createElement(NeedsYouCard, { approvals, decisions, onDecide() {}, onAnswer() {}, onSelect() {} }) : null);
  const view = await mount(shown([approval("a1"), approval("a2")], [decision]));
  const press = async (name: string) => {
    await act(async () => { const pressed = required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)); pressed.focus(); pressed.click(); });
  };
  const read = () => (dom.window.document.activeElement?.getAttribute("aria-describedby") ?? "").split(" ").map((id) => dom.window.document.getElementById(id)?.textContent);

  await press("Allow once");
  await view.render(shown([approval("a2")], [decision]));
  assert.equal(focusedName(), "Approval waiting on you");
  assert.deepEqual(read(), ["Thread a2", "Run a2?", "Lists the folder", "ls"]);
  await press("Deny");
  await view.render(shown([], [decision]));
  assert.equal(focusedName(), "Decision waiting on you");
  assert.deepEqual(read(), ["Settings", "Keep the v2 reader?"]);

  await press("Decide");
  await view.render(shown([], []));
  await settleFrame();
  assert.equal(focusedName(), "Composer", "with nothing left, the composer takes the keyboard");
  await view.unmount();
});

test("← and → turn the Needs-you card's pages, except while they move the caret in an answer", async () => {
  const approval: CoordinationApprovalView = { thread: member("a", "Login flake"), approval: { approvalId: "a1", taskId: "a", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "yarn test" } } };
  const decision: CoordinationDecisionView = { thread: member("b", "Settings"), decision: { id: "d1", question: "Keep the v2 reader?", options: [], raisedAt: 1 } };
  const view = await mount(React.createElement(NeedsYouCard, { approvals: [approval], decisions: [decision], onDecide() {}, onAnswer() {}, onSelect() {} }));
  const press = (target: Element, key: string) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const allow = required([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Allow once"));
  allow.focus();
  await press(allow, "ArrowRight");
  assert.ok(query(view.container, '[aria-label="Decision waiting on you"]'), "→ turns to the next page");
  assert.equal(document.activeElement?.getAttribute("data-action"), "next", "and the keyboard lands on the pager");

  const own = query<HTMLInputElement>(view.container, 'input[aria-label="Your own answer"]');
  await press(own, "ArrowLeft");
  assert.ok(query(view.container, '[aria-label="Decision waiting on you"]'), "← in the answer field moves the caret, not the page");

  await press(query(view.container, '[data-action="next"]'), "ArrowLeft");
  assert.ok(query(view.container, '[aria-label="Approval waiting on you"]'), "← turns back");
  await view.unmount();

  const alone = await mount(React.createElement(NeedsYouCard, { approvals: [approval], decisions: [], onDecide() {}, onAnswer() {}, onSelect() {} }));
  const only = query(alone.container, '[aria-label="Approval waiting on you"]');
  const arrow = new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => { only.dispatchEvent(arrow); });
  assert.equal(arrow.defaultPrevented, false, "a card with one page leaves the arrows alone");
  await alone.unmount();
});
