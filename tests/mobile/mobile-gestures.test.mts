import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { click, clickButton, clickRow, dom, lastCommand, live, openPhone, patchView, typeInto, view } from "../support/mobile-phone.mts";

/** A one-finger touch as React reads it: the event's `touches` and `changedTouches` lists. */
function touch(node: Element, type: "touchstart" | "touchmove" | "touchend", x: number, y: number) {
  const event = new dom.window.Event(type, { bubbles: true });
  const point = [{ clientX: x, clientY: y }];
  Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : point }, changedTouches: { value: point } });
  act(() => void node.dispatchEvent(event));
}

/** The page as the iOS home screen runs it, where no browser gesture owns the left edge. */
function standalone(on: boolean) {
  Object.defineProperty(dom.window.navigator, "standalone", { configurable: true, value: on || undefined });
}

function pointer(node: Element, type: string, clientY: number) {
  act(() => void node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientY })));
}

test("a swipe in from the left edge drags the screen and goes back, and one that starts mid-screen does not", () => {
  standalone(true);
  try {
    const line = openPhone({ paired: true });
    live(line);
    click(".thread-row .thread-open");
    const app = document.querySelector<HTMLElement>(".app")!;
    touch(app, "touchstart", 120, 300);
    touch(app, "touchend", 260, 300);
    assert.ok(document.querySelector(".composer"), "a swipe from the middle is a scroll, not a way back");

    touch(app, "touchstart", 8, 300);
    touch(app, "touchmove", 40, 302);
    assert.equal(app.style.transform, "translateX(32px)", "the screen follows the finger");
    touch(app, "touchend", 40, 302);
    assert.equal(app.style.transform, "", "a short swipe springs back");
    assert.ok(document.querySelector(".composer"));

    touch(app, "touchstart", 8, 300);
    touch(app, "touchmove", 120, 310);
    touch(app, "touchend", 120, 310);
    assert.ok(document.querySelector(".thread-list"), "back on the list");
    assert.equal(app.style.transform, "");
  } finally {
    standalone(false);
  }
});

test("in a browser tab the edge belongs to the browser, whose back steps back a screen", async () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  const app = document.querySelector(".app")!;
  touch(app, "touchstart", 8, 300);
  touch(app, "touchend", 120, 310);
  assert.ok(document.querySelector(".composer"), "the page leaves the edge to the browser");
  await act(async () => {
    window.history.back();
    await new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
  });
  assert.ok(document.querySelector(".thread-list"), "the browser's back is a step back to the list");
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

test("a draft's project chip starts the draft over in another project", () => {
  const line = openPhone({ paired: true });
  const drafting = view();
  drafting.thread = null;
  drafting.draft = { projectId: "p", projectName: "App", settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" }, worktree: false, worktreeName: null, worktrees: [], canWorktree: true };
  live(line, drafting);
  click('.bar button[aria-label^="New thread"]');
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

function openRowMenu() {
  act(() => void document.querySelector(".thread-row .thread-open")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
}

test("a long press or a context menu on a row puts its options up over the list", () => {
  const line = openPhone({ paired: true });
  live(line);
  const sent = line.sent.length;
  openRowMenu();
  assert.equal(line.sent.length, sent, "the Mac's open thread stays where it is");
  assert.ok(document.querySelector(".thread-list"), "the list stays");
  assert.equal(document.querySelector(".scrim")?.getAttribute("aria-label"), "Thread options");
  assert.equal(document.querySelector(".sheet-head h2")?.textContent, "Fix the parser");
  clickButton("Done", ".sheet");
  assert.ok(document.querySelector(".thread-list"), "Done leaves the list as it was");

  openRowMenu();
  clickRow("Open");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "Fix the parser");
});

test("a row's options rename, fork and archive it from the list, and archiving asks first", () => {
  const line = openPhone({ paired: true });
  live(line);
  openRowMenu();
  assert.equal([...document.querySelectorAll(".menu-row")].some((row) => row.textContent?.startsWith("Dismiss")), false, "a row with nothing to file away offers no Dismiss");
  clickRow("Rename");
  typeInto(".rename-form input", "Parse faster");
  clickButton("Save", ".sheet");
  assert.deepEqual(lastCommand(line), { type: "task.rename", taskId: "t1", title: "Parse faster" });

  openRowMenu();
  clickRow("Fork thread");
  assert.deepEqual(lastCommand(line), { type: "task.fork", taskId: "t1" });

  openRowMenu();
  const sent = line.sent.length;
  clickRow("Archive…");
  assert.equal(line.sent.length, sent, "nothing is archived until the question is answered");
  assert.equal(document.querySelector(".sheet-head h2")?.textContent, "Archive “Fix the parser”?");
  assert.match(document.querySelector(".sheet-lead")?.textContent ?? "", /Settings › Archived threads/);
  clickButton("Cancel", ".sheet");
  assert.equal(document.querySelector(".sheet"), null);
  assert.equal(line.sent.length, sent, "Cancel archives nothing");

  openRowMenu();
  clickRow("Archive…");
  clickRow("Archive");
  assert.deepEqual(lastCommand(line), { type: "task.archive", taskId: "t1" });
  assert.equal(document.querySelector(".sheet"), null);
});

test("a row a finger rests on sinks until the press lands or lets go", () => {
  const line = openPhone({ paired: true });
  live(line);
  const row = document.querySelector<HTMLElement>(".thread-row .thread-open")!;
  act(() => void row.dispatchEvent(Object.assign(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }), { pointerType: "touch" })));
  assert.equal(row.dataset.pressing, "");
  act(() => void row.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true })));
  assert.equal(row.dataset.pressing, undefined);
});

test("a plain tap on a row opens the thread with no sheet up", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".sheet"), null);
});

test("a thread's options button shows, off, while the thread is still on its way", () => {
  const line = openPhone({ paired: true });
  const two = view();
  two.groups[0]!.threads.push({ ...two.groups[0]!.threads[0]!, id: "t2", title: "Rewrite the docs" });
  live(line, two);
  click('.thread-row:nth-of-type(2) .thread-open');
  assert.equal(document.querySelector<HTMLButtonElement>('button[aria-label="Thread options"]')?.disabled, true);
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "patch", sequence: 2, patch: { thread: { kind: "opened", thread: { ...two.thread!, id: "t2", title: "Rewrite the docs" } } } }) }));
  assert.equal(document.querySelector<HTMLButtonElement>('button[aria-label="Thread options"]')?.disabled, false);
});

test("the settings sheet's arrow keys move focus within a group, and only a press makes the choice", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click(".composer-settings");
  const modes = () => [...document.querySelectorAll<HTMLButtonElement>('.sheet-group[aria-label="Mode"] [role="radio"]')];
  assert.deepEqual(modes().map((node) => node.tabIndex).filter((index) => index === 0).length, 1);
  const checked = modes().findIndex((node) => node.getAttribute("aria-checked") === "true");
  const next = (checked + 1) % modes().length;
  const sent = line.sent.length;
  act(() => void modes()[checked]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert.ok(document.activeElement === modes()[next], "focus moves to the next choice, wrapping at the end");
  assert.equal(line.sent.length, sent, "arrowing past a choice sends nothing");
  assert.equal(modes()[checked]?.getAttribute("aria-checked"), "true");
  act(() => void modes()[next]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(lastCommand(line)?.type, "task.set-policy");
  assert.equal(modes()[next]?.getAttribute("aria-checked"), "true");
  assert.deepEqual(modes().map((node) => node.tabIndex), modes().map((_, index) => index === next ? 0 : -1));
});

test("a draft's worktree chip opens Start in, with or without worktrees to pick", () => {
  const line = openPhone({ paired: true });
  const drafting = view();
  drafting.thread = null;
  drafting.draft = { projectId: "p", projectName: "App", settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" }, worktree: false, worktreeName: null, worktrees: [], canWorktree: true };
  live(line, drafting);
  click('.bar button[aria-label^="New thread"]');
  const chip = () => document.querySelector<HTMLButtonElement>("button.thread-start-where");
  assert.equal(chip()?.getAttribute("aria-haspopup"), "dialog");
  assert.equal(chip()?.hasAttribute("aria-pressed"), false);
  click("button.thread-start-where");
  assert.equal(document.querySelector('.sheet [role="radiogroup"]')?.getAttribute("aria-label"), "Where this thread starts");
  assert.deepEqual([...document.querySelectorAll(".sheet .location-option strong")].map((node) => node.textContent), ["App", "New worktree"]);
  clickButton("New worktreeA checkout of its own, cut from the project", ".sheet");
  assert.deepEqual(lastCommand(line), { type: "task.set-worktree", worktree: true });
  assert.equal(document.querySelector(".sheet"), null);
});

test("Rename offers Cancel beside Save, and Cancel renames nothing", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Rename");
  assert.equal(document.querySelector<HTMLButtonElement>(".sheet-head button:last-child")?.disabled, true, "Save waits for a change");
  const sent = line.sent.length;
  clickButton("Cancel", ".sheet");
  assert.equal(document.querySelector(".sheet"), null);
  assert.equal(line.sent.length, sent);
});

test("a folded group that needs the user says so", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".section-toggle");
  assert.equal(document.querySelector(".section-toggle .sr-only")?.textContent, "Needs you");
});

test("an unpaired phone takes the code typed from the computer, and only a whole one", () => {
  openPhone();
  const pair = () => document.querySelector<HTMLButtonElement>(".gate-code button")!;
  assert.equal(pair().disabled, true);
  typeInto(".gate-code input", "k7m2");
  assert.equal(pair().disabled, true, "half a code is not sent");
  assert.equal(document.querySelector(".gate-error"), null);
  typeInto(".gate-code input", "k7m2p9qx");
  assert.equal(document.querySelector<HTMLInputElement>(".gate-code input")?.value, "K7M2P9QX");
  assert.equal(pair().disabled, false);
});

test("a typed code forgives look-alike letters and dashes, and says so when it is no code at all", () => {
  openPhone();
  const pair = () => document.querySelector<HTMLButtonElement>(".gate-code button")!;
  typeInto(".gate-code input", "k7m2-p9ox");
  assert.equal(document.querySelector<HTMLInputElement>(".gate-code input")?.value, "K7M2P90X", "O reads as the zero it is mistaken for");
  assert.equal(pair().disabled, false);
  typeInto(".gate-code input", "K7M2P9QU");
  assert.equal(pair().disabled, true);
  assert.match(document.querySelector(".gate-error[role=alert]")?.textContent ?? "", /Not a pairing code/);
  assert.equal(document.querySelector(".gate-code input")?.getAttribute("aria-invalid"), "true");
});

test("a project search that finds nothing offers to clear itself", () => {
  const line = openPhone({ paired: true });
  live(line);
  click('.segmented button[aria-checked="false"]');
  click(".list-filter");
  typeInto(".sheet-search input", "zzz");
  assert.equal(document.querySelectorAll('.sheet [role="radio"]').length, 0);
  clickButton("Clear search", ".sheet");
  assert.equal(document.querySelector<HTMLInputElement>(".sheet-search input")?.value, "");
  assert.ok(document.activeElement === document.querySelector(".sheet-search input"), "the field keeps the keyboard");
  assert.ok(document.querySelectorAll('.sheet [role="radio"]').length > 0);
  localStorage.removeItem("aicodingtool.mobile.list");
});
