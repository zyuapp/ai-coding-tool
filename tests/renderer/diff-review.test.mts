import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

/** A session card row, found by the label it shows. */
function sessionRow(container: Element, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button.session-row")].find((row) => row.querySelector(":scope > span:nth-of-type(2)")?.textContent === label);
}

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");

type MountView = Awaited<ReturnType<typeof mount>>;

const REVIEW_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 22;",
  "+const third = 3;",
  "",
].join("\n");

function seedReviewableProject() {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "review-task",
      title: "Review",
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuationStatus: "none",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      projectId: "project-1",
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }] }),
    lastFolder: JSON.stringify({ version: 2, value: "/project" }),
  }));
}

/** Opens the review from the session panel and lets its patches land. */
async function openReview(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
  await act(async () => { item(sessionRow(view.container, "Changes")).click(); });
  /** Names are held back until a patch lands, and the first patch waits on its grammar being imported. */
  for (let turn = 0; turn < 100 && !view.container.querySelector(".diff-file-row"); turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A review opens side by side, so the one-column view is what a test has to ask for. */
async function showOneColumn(view: MountView) {
  const twoColumns = query<HTMLButtonElement>(view.container, 'button[aria-label="Two columns"]');
  assert.equal(twoColumns.getAttribute("aria-pressed"), "true");
  await act(async () => { twoColumns.click(); });
  assert.equal(twoColumns.getAttribute("aria-pressed"), "false");
}

/** Opens the session panel, which is where the Changes row that reaches the review lives. */
async function showSession(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
}

/** A desktop whose comparison holds one changed file with a patch to draw. */
function reviewableDesktop() {
  return fakeDesktop({
    diffSummary: async (_workspaceId, range, ignoreWhitespace = false) => ({
      status: "available",
      range,
      ignoreWhitespace,
      files: [{ path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false }],
      additions: 2,
      deletions: 1,
    }),
    diffPatch: async () => ({ status: "available", patch: REVIEW_PATCH }),
  });
}

test("the session panel's Changes row opens the review, and the same click closes it", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));

  const tabs = () => [...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent);
  await openReview(view);

  assert.deepEqual(tabs(), ["Changes1"], "the review opens as the dock's tab, counting the file still to read");
  assert.equal(query(view.container, ".diff-file-name").textContent, "src/app.ts");
  assert.match(query(view.container, ".diff-progress").textContent, /0 of 1 viewed/);

  /** The dock takes the session panel's place, so the row that opened the review is closed from the tab. */
  await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-tab.active button[aria-label="Close Changes"]').click(); });
  assert.deepEqual([tabs(), view.container.querySelector(".diff-panel")], [[], null], "closing the tab unmounts its retained patch data");
  await showSession(view);
  assert.ok((sessionRow(view.container, "Changes") ?? null), "the row is back to open it again");
  await view.unmount();
});

test("a range picked in the gutter becomes a composer pill naming the file and its lines", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);

  const gutters = [...view.container.querySelectorAll<HTMLElement>(".diff-gutter")];
  await act(async () => { gutters[2].click(); });
  await act(async () => { gutters[3].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })); });

  assert.equal(view.container.querySelectorAll(".diff-line.selected").length, 2, "shift extends the selection");
  assert.match(query(view.container, ".diff-comment-range").textContent, /^src\/app\.ts:L2-L3$/);

  /** The note is written among the lines it is about, not docked away below the whole review. */
  const drawn = [...view.container.querySelectorAll(".diff-files .diff-line, .diff-files .diff-comment")];
  const composer = drawn.findIndex((node) => node.classList.contains("diff-comment"));
  assert.ok(composer > 0, "the composer is drawn with the rows, inside the scroller");
  assert.ok(drawn[composer - 1].classList.contains("selected"), "it follows the last selected line");

  const note = query<HTMLTextAreaElement>(view.container, '.diff-comment textarea');
  await act(async () => {
    note.value = "Name these properly";
    note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Comment on the selected lines"]').click(); });

  const pill = view.container.querySelector(".annotation-pill");
  assert.ok(pill, "the note lands in the composer as a pill");
  assert.equal(query(pill, ".annotation-pill-label").textContent, "Name these properly", "the pill wears the note, not the quote");
  assert.match(query(pill, ".annotation-card-quote").textContent, /src\/app\.ts:L2-L3/);
  assert.match(query(pill, ".annotation-card-quote").textContent, /\+const second = 22;/);
  assert.equal(view.container.querySelector(".diff-comment"), null, "commenting clears the selection");

  const marker = query<HTMLButtonElement>(view.container, ".diff-inline-comment-markers button"); assert.deepEqual([marker.textContent, view.container.querySelectorAll(".diff-line.commented").length], ["1", 2], "the range keeps the pill's numbered marker");
  await act(async () => { marker.click(); }); assert.equal(query<HTMLTextAreaElement>(view.container, ".diff-comment textarea").value, "Name these properly", "the marker reopens its note");
  await view.unmount();
});

test("lines are picked by dragging down the gutter, and from the keyboard without a Tab stop on every line", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);
  const gutters = () => [...view.container.querySelectorAll<HTMLElement>(".diff-gutter")];
  assert.ok(gutters().every((gutter) => gutter.tabIndex === -1), "a review is not hundreds of Tab stops");

  const pointer = (type: string, target: Element, init: PointerEventInit = {}) => target.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, buttons: 1, ...init }));
  await act(async () => { pointer("pointerdown", gutters()[1]); });
  await act(async () => { pointer("pointerover", query(view.container, ".diff-line.add code")); });
  assert.equal(view.container.querySelector(".diff-comment"), null, "the note waits while the drag is still picking");
  await act(async () => { pointer("pointerover", gutters()[3]); });
  await act(async () => { window.dispatchEvent(new dom.window.PointerEvent("pointerup", { buttons: 0 })); });
  assert.equal(view.container.querySelectorAll(".diff-line.selected").length, 3, "the drag picked every line it crossed");
  assert.match(query(view.container, ".diff-comment-range").textContent, /^src\/app\.ts:L2-L3$/);
  assert.equal(dom.window.document.activeElement, query(view.container, ".diff-comment textarea"), "letting go hands the keyboard to the note");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Clear the selection"]').click(); });
  const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const header = query<HTMLButtonElement>(view.container, ".diff-files .diff-file-open");
  header.focus();
  await act(async () => { key(header, { key: "ArrowDown" }); });
  assert.equal(dom.window.document.activeElement, gutters()[0], "Down from a file's row reaches its first line");
  await act(async () => { key(gutters()[0], { key: "ArrowDown", shiftKey: true }); });
  await act(async () => { key(gutters()[1], { key: "ArrowDown", shiftKey: true }); });
  assert.equal(view.container.querySelectorAll(".diff-line.selected").length, 3, "Shift with Down picks the next line each time");
  assert.equal(dom.window.document.activeElement, gutters()[2], "the keyboard stays in the gutter so the run can keep growing");
  await act(async () => { key(gutters()[2], { key: "Enter" }); });
  assert.equal(dom.window.document.activeElement, query(view.container, ".diff-comment textarea"), "Enter on a picked line goes to its note");
  await view.unmount();
});

test("ticking a file off folds its patch away and empties the tab's count", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  assert.ok(view.container.querySelectorAll(".diff-line").length > 0, "the patch is open");

  await act(async () => { query<HTMLInputElement>(view.container, 'input[aria-label="Mark src/app.ts viewed"]').click(); });

  assert.equal(view.container.querySelectorAll(".diff-line").length, 0);
  assert.equal(query(view.container, ".diff-progress-done").textContent, "Viewed");
  assert.deepEqual([...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent), ["Changes"]);
  await view.unmount();
});

/** A comparison of three files, so a review has somewhere to go when one of them is ticked off. */
function threeFileDesktop() {
  return fakeDesktop({
    diffSummary: async (_workspaceId, range, ignoreWhitespace = false) => ({
      status: "available",
      range,
      ignoreWhitespace,
      files: ["src/one.ts", "src/two.ts", "src/three.ts"].map((path) => ({ path, status: "modified" as const, additions: 2, deletions: 1, binary: false })),
      additions: 6,
      deletions: 3,
    }),
    diffPatch: async () => ({ status: "available", patch: REVIEW_PATCH }),
  });
}

/** Which row the review was scrolled to, since jsdom scrolls nothing of its own. */
function watchScrolling() {
  const original = item(Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollIntoView"));
  const scrolled: string[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) { scrolled.push(this.querySelector(".diff-file-name")?.textContent ?? this.className); },
  });
  return { scrolled, restore() { Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", original); } };
}

test("ticking a file off brings the next file still to read to the top", async () => {
  seedReviewableProject();
  window.desktop = threeFileDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  const watch = watchScrolling();

  const tick = (path: string) => act(async () => { query<HTMLInputElement>(view.container, `input[aria-label="Mark ${path} viewed"]`).click(); });

  await tick("src/one.ts");
  assert.deepEqual(watch.scrolled, ["src/two.ts"], "the file under the one just read comes to the top");

  await tick("src/two.ts");
  assert.deepEqual(watch.scrolled, ["src/two.ts", "src/three.ts"], "and so on down the list, one click a file");

  await tick("src/three.ts");
  assert.deepEqual(watch.scrolled, ["src/two.ts", "src/three.ts"], "nothing is left below, so the review stays where the user left it");

  await tick("src/one.ts");
  assert.deepEqual(watch.scrolled, ["src/two.ts", "src/three.ts"], "un-ticking a file opens it where the reader already is");

  watch.restore();
  await view.unmount();
});

test("a comment can be taken from either column of the two-column view", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  const gutters = [...view.container.querySelectorAll<HTMLElement>(".diff-split-cell .diff-gutter")];
  /** Each side says what happened to its line, so the two columns never announce the same thing. */
  assert.deepEqual(gutters.map((gutter) => gutter.getAttribute("aria-label")), [
    "Add comment on unchanged line 1",
    "Add comment on unchanged line 1",
    "Add comment on removed line 2",
    "Add comment on added line 2",
    "Add comment on added line 3",
  ]);
  await act(async () => { item(gutters.find((gutter) => gutter.getAttribute("aria-label") === "Add comment on added line 3")).click(); });

  assert.match(query(view.container, ".diff-comment-range").textContent, /^src\/app\.ts:L3$/);
  await view.unmount();
});

test("Branch is the default, with current work before the editable target branch", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  assert.ok(view.container.querySelector('button[aria-label="Review mode: Branch"]'));
  const sides = () => [...view.container.querySelectorAll(".diff-side-trigger > span")].map((code) => code.textContent);
  assert.deepEqual(sides(), ["main · working", "HEAD"], "current work appears before the target, even without a remote baseline, and reads apart from the branch itself");

  /** The trigger names the side and what it is set to, so a screen reader hears the comparison. */
  assert.equal(query<HTMLButtonElement>(view.container, '.diff-side button').getAttribute("aria-label"), "Compare: Working tree on main");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Target branch"]').click(); });
  const options = [...document.querySelectorAll('.branch-menu [role="option"]')].map((option) => option.textContent);
  assert.equal(options[0], "HEAD", "the side that is not a branch comes first, inside the list");
  assert.ok(options.includes("origin/main"), "a remote branch can be a base");

  await act(async () => { item([...document.querySelectorAll<HTMLElement>('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main")).click(); });
  assert.deepEqual(sides(), ["main · working", "origin/main"]);
  await view.unmount();
});

test("a review hides the lines that only moved, and showing them reads the comparison again", async () => {
  seedReviewableProject();
  const asked: boolean[] = [];
  window.desktop = fakeDesktop({
    diffSummary: async (_workspaceId, range, ignoreWhitespace = true) => {
      asked.push(ignoreWhitespace);
      return {
        status: "available",
        range,
        ignoreWhitespace,
        files: [
          { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false },
          ...(ignoreWhitespace ? [] : [{ path: "src/spaced.ts", status: "modified" as const, additions: 1, deletions: 1, binary: false }]),
        ],
        additions: ignoreWhitespace ? 2 : 3,
        deletions: ignoreWhitespace ? 1 : 2,
      };
    },
    diffPatch: async () => ({ status: "available", patch: REVIEW_PATCH }),
  });
  const view = await mount(React.createElement(App));
  await openReview(view);

  const names = () => [...view.container.querySelectorAll(".diff-files .diff-file-name")].map((name) => name.textContent);
  assert.deepEqual(names(), ["src/app.ts"], "the file whose lines only moved is not in the review");
  const spacing = query<HTMLButtonElement>(view.container, 'button[aria-label="Hide spacing changes"]');
  assert.equal(spacing.getAttribute("aria-pressed"), "true");

  await act(async () => { spacing.click(); });
  for (let turn = 0; turn < 100 && names().length < 2; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.deepEqual(asked, [true, false], "the same comparison is read again, counted with whitespace");
  assert.deepEqual(names(), ["src/app.ts", "src/spaced.ts"]);
  assert.equal(spacing.getAttribute("aria-pressed"), "false", "the button offers the way back");
  await view.unmount();
});

/** The mode menu is a portal, like the branch picker it replaces. */
async function chooseMode(view: MountView, label: string) {
  await act(async () => { query<HTMLButtonElement>(view.container, '.diff-mode-trigger').click(); });
  const option = item([...document.querySelectorAll<HTMLButtonElement>('.diff-mode-menu button')].find((button) => button.querySelector(".picker-label")?.firstChild?.textContent === label));
  await act(async () => { option.click(); });
}

test("the review switches to uncommitted changes and returns to its branch target", async () => {
  seedReviewableProject();
  const ranges: unknown[] = [];
  const desktop = reviewableDesktop();
  window.desktop = fakeDesktop({
    diffSummary: async (workspaceId, range, whitespace) => { ranges.push(range); return desktop.diffSummary(workspaceId, range, whitespace); },
    diffPatch: desktop.diffPatch,
  });
  const view = await mount(React.createElement(App));
  try {
    await openReview(view);
    await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Target branch"]').click(); });
    await act(async () => { item([...document.querySelectorAll<HTMLElement>('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main")).click(); });
    await chooseMode(view, "Uncommitted");
    assert.deepEqual(ranges.at(-1), { kind: "uncommitted" });
    assert.ok(view.container.querySelector('button[aria-label="Review mode: Uncommitted"]'));
    await chooseMode(view, "Branch");
    assert.deepEqual(ranges.at(-1), { kind: "branches", base: "origin/main", compare: null });
    assert.deepEqual([...view.container.querySelectorAll('.diff-side-trigger > span')].map((span) => span.textContent), ["main · working", "origin/main"]);
  } finally { await view.unmount(); }
});

test("the progress line takes the reader to the next file still to read", async () => {
  seedReviewableProject();
  window.desktop = threeFileDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  const watch = watchScrolling();
  const next = () => view.container.querySelector<HTMLButtonElement>(".diff-progress button");

  assert.equal(item(next()).textContent, "0 of 3 viewed");
  await act(async () => { item(next()).click(); });
  assert.deepEqual(watch.scrolled, ["src/one.ts"]);

  for (const path of ["src/one.ts", "src/two.ts", "src/three.ts"]) {
    await act(async () => { query<HTMLInputElement>(view.container, `input[aria-label="Mark ${path} viewed"]`).click(); });
  }
  assert.equal(next(), null, "a finished review has nowhere left to go");
  assert.equal(query(view.container, ".diff-progress-done").textContent, "All 3 viewed");

  watch.restore();
  await view.unmount();
});

test("N takes the reader to the next file still to read, and leaves a typed n alone", async () => {
  seedReviewableProject();
  window.desktop = threeFileDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  const watch = watchScrolling();
  const press = (target: Element) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true })); });

  await press(query(view.container, ".diff-file-open"));
  assert.deepEqual(watch.scrolled, ["src/one.ts"]);

  await act(async () => { query<HTMLButtonElement>(view.container, ".diff-files .diff-gutter").click(); });
  watch.scrolled.length = 0;
  await press(query(view.container, ".diff-comment textarea"));
  assert.deepEqual(watch.scrolled, [], "a note being typed keeps its n");

  watch.restore();
  await view.unmount();
});

test("the Changes tab says what its count is counting", async () => {
  seedReviewableProject();
  window.desktop = threeFileDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  const badge = query(view.container, '.right-dock-tab [role="tab"] > em');
  assert.equal(badge.getAttribute("role"), "img");
  assert.equal(badge.getAttribute("aria-label"), "3 files unreviewed");
  await view.unmount();
});

test("a comparison that cannot be read says so as an error, and Try again reads it again", async () => {
  seedReviewableProject();
  let reads = 0;
  const working = reviewableDesktop();
  window.desktop = fakeDesktop({
    ...working,
    diffSummary: async (...args: Parameters<typeof working.diffSummary>) => {
      reads += 1;
      return reads === 1 ? { status: "error", message: "git exited with 128" } : working.diffSummary(...args);
    },
  });
  const view = await mount(React.createElement(App));
  await showSession(view);
  await act(async () => { item(sessionRow(view.container, "Changes")).click(); });
  for (let turn = 0; turn < 50 && !view.container.querySelector(".diff-error"); turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const error = query(view.container, ".diff-error");
  assert.equal(error.getAttribute("role"), "alert");
  assert.match(error.textContent, /git exited with 128/);
  await act(async () => { query<HTMLButtonElement>(error, "button").click(); });
  for (let turn = 0; turn < 100 && !view.container.querySelector(".diff-file-row"); turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.ok(reads >= 2);
  assert.equal(view.container.querySelector(".diff-error"), null);
  assert.ok(view.container.querySelector(".diff-file-row"), "the review draws once the read succeeds");
  await view.unmount();
});
