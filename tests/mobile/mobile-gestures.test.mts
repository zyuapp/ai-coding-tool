import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { act } from "react";
import { click, clickButton, clickRow, dom, lastCommand, live, openPhone, view } from "../support/mobile-phone.mts";

/** A one-finger touch as React reads it: the event's `touches` and `changedTouches` lists. */
function touch(node: Element, type: "touchstart" | "touchend", x: number, y: number) {
  const event = new dom.window.Event(type, { bubbles: true });
  const point = [{ clientX: x, clientY: y }];
  Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : point }, changedTouches: { value: point } });
  act(() => void node.dispatchEvent(event));
}

function pointer(node: Element, type: string, clientY: number) {
  act(() => void node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientY })));
}

test("a swipe in from the left edge goes back, and one that starts mid-screen does not", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  const app = document.querySelector(".app")!;
  touch(app, "touchstart", 120, 300);
  touch(app, "touchend", 260, 300);
  assert.ok(document.querySelector(".composer"), "a swipe from the middle is a scroll, not a way back");
  touch(app, "touchstart", 8, 300);
  touch(app, "touchend", 120, 310);
  assert.ok(document.querySelector(".thread-list"), "back on the list");
});

test("the list switch moves with the arrow keys and keeps one Tab stop", () => {
  const line = openPhone({ paired: true });
  live(line);
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('.bar [role="radio"]')];
  assert.deepEqual(radios().map((node) => node.tabIndex), [0, -1]);
  act(() => void radios()[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  assert.equal(radios()[1]?.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, radios()[1]);
  assert.equal(localStorage.getItem("aicodingtool.mobile.list"), "activity");
  localStorage.removeItem("aicodingtool.mobile.list");
});

test("a notice leaves the list switch in place", () => {
  const line = openPhone({ paired: true });
  const failed = view();
  failed.error = "That worktree is busy.";
  live(line, failed);
  assert.ok(document.querySelector('.bar [role="radiogroup"]'));
  assert.ok(document.querySelector(".banner"));
});

test("a sheet pulled down by its head far enough closes, and a short pull springs back", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click(".composer-settings");
  const head = () => document.querySelector(".sheet-head h2")!;
  pointer(head(), "pointerdown", 100);
  pointer(head(), "pointermove", 140);
  assert.equal(document.querySelector<HTMLElement>(".sheet")?.style.transform, "translateY(40px)");
  pointer(head(), "pointerup", 140);
  assert.ok(document.querySelector(".sheet"), "a short pull keeps the sheet up");
  assert.equal(document.querySelector<HTMLElement>(".sheet")?.style.transform, "");
  pointer(head(), "pointerdown", 100);
  pointer(head(), "pointermove", 220);
  pointer(head(), "pointerup", 220);
  assert.equal(document.querySelector(".sheet"), null);
});

test("Undo after archiving stays while a finger is on it", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line);
    click(".thread-row .thread-open");
    click('button[aria-label="Thread options"]');
    clickRow("Archive");
    const toast = document.querySelector(".undo-toast")!;
    pointer(toast, "pointerdown", 0);
    act(() => void vi.advanceTimersByTime(20_000));
    assert.ok(document.querySelector(".undo-toast"), "held, it stays");
    pointer(toast, "pointerup", 0);
    act(() => void vi.advanceTimersByTime(8_000));
    assert.ok(document.querySelector(".undo-toast"));
    act(() => void vi.advanceTimersByTime(2_000));
    assert.equal(document.querySelector(".undo-toast"), null);
  } finally {
    vi.useRealTimers();
  }
});

test("a draft's project chip starts the draft over in another project", () => {
  const line = openPhone({ paired: true });
  const drafting = view();
  drafting.thread = null;
  drafting.draft = { projectId: "p", projectName: "App", settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" }, worktree: false, worktreeName: null, worktrees: [], canWorktree: true };
  live(line, drafting);
  click('.bar button[aria-label="New thread"]');
  click("button.thread-start-project");
  assert.equal(document.querySelector('.sheet [role="radiogroup"]')?.getAttribute("aria-label"), "Start in");
  clickButton("No project", ".sheet");
  assert.deepEqual(lastCommand(line), { type: "task.new" });
});

test("a code block in an answer carries its own copy button", () => {
  const line = openPhone({ paired: true });
  const coded = view();
  coded.thread = { ...coded.thread!, messages: [{ kind: "assistant", text: "Run:\n\n```sh\nyarn test\n```", at: 1 }] };
  live(line, coded);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".markdown .code-block pre")?.textContent, "yarn test\n");
  assert.equal(document.querySelector(".markdown .code-block button")?.getAttribute("aria-label"), "Copy code");
});

test("the location sheet opens on where the thread already is, which is not a move", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Location");
  const current = document.querySelector<HTMLButtonElement>('.location-option[aria-checked="true"]');
  assert.equal(document.activeElement, current);
  const sent = line.sent.length;
  click('.location-option[aria-checked="true"]');
  assert.equal(line.sent.length, sent);
  assert.ok(document.querySelector(".sheet"));
});
