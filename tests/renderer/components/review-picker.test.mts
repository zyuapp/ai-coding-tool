import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { ReviewTarget } from "../../../src/domain/review.ts";
import type { DesktopAPI } from "../../../src/contracts/ipc.ts";

Object.defineProperty(window, "desktop", { configurable: true, writable: true, value: {
  branches: async () => ({ status: "available", branches: ["main", "release", "feature"], remotes: [], current: "feature" } as const),
} satisfies Pick<DesktopAPI, "branches"> });

const { ReviewPicker } = await import("../../../src/renderer/components/ReviewPicker.tsx");

type Step = "targets" | "base" | "commit" | "custom";

async function open(step: Step) {
  const calls = { steps: [] as Step[], reviews: [] as ReviewTarget[], closed: 0 };
  const view = await mount(React.createElement(ReviewPicker, {
    picker: { taskId: "task-1", step },
    workspaceId: "workspace-1",
    engineLabel: "Codex",
    returnFocus: { current: null },
    onStep: (next: Step) => { calls.steps.push(next); },
    onReview: (target: ReviewTarget) => { calls.reviews.push(target); },
    onClose: () => { calls.closed += 1; },
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { view, calls };
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    field.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
  });
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
}

test("a commit is reviewed only once its SHA is hex, and anything else says so", async () => {
  const { view, calls } = await open("commit");
  const field = query<HTMLInputElement>(view.container, ".review-form input");
  const start = query<HTMLButtonElement>(view.container, ".review-form-actions button.primary");
  assert.equal(start.disabled, true);
  assert.equal(start.textContent?.includes("Start review"), true);
  assert.equal(query(start, "kbd").getAttribute("aria-hidden"), "true");

  await type(field, "a1b");
  assert.equal(start.disabled, true, "three characters are still being typed");
  assert.equal(view.container.querySelector(".review-form-error"), null);
  const hint = query(view.container, ".review-form-hint");
  assert.equal(hint.textContent, "At least 4 characters", "a short SHA says why it cannot start yet");
  assert.equal(field.getAttribute("aria-describedby"), hint.id);

  await type(field, "HEAD~1");
  assert.equal(start.disabled, true);
  assert.equal(field.getAttribute("aria-invalid"), "true");
  assert.equal(query(view.container, ".review-form-error").getAttribute("role"), "alert");
  await act(async () => { query<HTMLFormElement>(view.container, ".review-form").requestSubmit(); });
  assert.deepEqual(calls.reviews, []);

  await type(field, " a1b2c3d ");
  assert.equal(start.disabled, false);
  assert.equal(view.container.querySelector(".review-form-error"), null);
  assert.equal(view.container.querySelector(".review-form-hint"), null);
  await act(async () => { query<HTMLFormElement>(view.container, ".review-form").requestSubmit(); });
  assert.deepEqual(calls.reviews, [{ type: "commit", sha: "a1b2c3d", title: null }]);
  await view.unmount();
});

test("custom instructions start on Enter, like the composer, and Shift+Enter stays a new line", async () => {
  const { view, calls } = await open("custom");
  const field = query<HTMLTextAreaElement>(view.container, ".review-form textarea");
  await press(field, "Enter");
  assert.deepEqual(calls.reviews, [], "nothing to review yet");

  await type(field, "check the reducer");
  await press(field, "Enter", { shiftKey: true });
  assert.deepEqual(calls.reviews, []);
  await press(field, "Enter");
  assert.deepEqual(calls.reviews, [{ type: "custom", instructions: "check the reducer" }]);
  await view.unmount();
});

test("arrow keys in the branch search move the highlighted branch, which Enter reviews against", async () => {
  const { view, calls } = await open("base");
  const search = query<HTMLInputElement>(view.container, ".review-search input");
  const selected = () => [...view.container.querySelectorAll('.review-branch-list [role="option"]')].filter((option) => option.getAttribute("aria-selected") === "true").map((option) => option.textContent);
  assert.deepEqual(selected(), ["main"]);
  assert.equal(query(view.container, ".review-heading > span").textContent, "Compare feature with…", "the heading names the branch under review");

  await press(search, "ArrowDown");
  assert.deepEqual(selected(), ["release"]);
  assert.equal(search.getAttribute("aria-activedescendant"), query(view.container, ".review-branch-list .active").id);
  await press(search, "Enter");
  assert.deepEqual(calls.reviews, [{ type: "baseBranch", branch: "release" }]);
  await view.unmount();
});

test("Escape steps back to the review options, and closes from there", async () => {
  const deeper = await open("commit");
  await press(query(deeper.view.container, ".review-form input"), "Escape");
  assert.deepEqual(deeper.calls.steps, ["targets"]);
  assert.equal(deeper.calls.closed, 0);
  await deeper.view.unmount();

  const top = await open("targets");
  assert.match(query(top.view.container, ".review-heading").textContent ?? "", /Esc/, "the heading names the key that backs out");
  await press(query(top.view.container, '[role="option"]'), "Escape");
  assert.equal(top.calls.closed, 1);
  await act(async () => { query<HTMLButtonElement>(top.view.container, ".review-close").click(); });
  assert.equal(top.calls.closed, 2);
  await top.view.unmount();
});

test("a branch search with nothing left tells a missed query from a checkout with no other branch", async () => {
  const { view } = await open("base");
  const search = query<HTMLInputElement>(view.container, ".review-search input");
  await type(search, "nope");
  assert.equal(query(view.container, ".review-branch-list .command-empty").textContent, "No branch matches");
  await view.unmount();

  const desktop = window.desktop;
  window.desktop = { branches: async () => ({ status: "available", branches: ["main"], remotes: [], current: "main" } as const) } as unknown as typeof window.desktop;
  const lone = await open("base");
  assert.equal(query(lone.view.container, ".review-branch-list .command-empty").textContent, "No other branch to compare with");
  await lone.view.unmount();
  window.desktop = desktop;
});

test("instructions typed into a step are still there after stepping back and returning", async () => {
  function Harness() {
    const [step, setStep] = React.useState<Step>("custom");
    return React.createElement(ReviewPicker, {
      picker: { taskId: "task-1", step },
      workspaceId: "workspace-1",
      engineLabel: "Codex",
      returnFocus: { current: null },
      onStep: setStep,
      onReview: () => {},
      onClose: () => {},
    });
  }
  const view = await mount(React.createElement(Harness));
  await type(query<HTMLTextAreaElement>(view.container, ".review-form textarea"), "check the cache");
  await press(query(view.container, ".review-form textarea"), "Escape");
  assert.equal(view.container.querySelector(".review-form textarea"), null, "Escape went back to the options");

  const custom = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes("Custom"))!;
  await act(async () => { custom.click(); });
  const field = query<HTMLTextAreaElement>(view.container, ".review-form textarea");
  assert.equal(field.value, "check the cache");
  assert.equal(dom.window.document.activeElement, field);
  assert.equal(field.selectionStart, field.value.length, "the caret lands after the draft");
  await view.unmount();
});
