import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

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
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Review changes"]').click(); });
  /** Names are held back until a patch lands, and the first patch waits on its grammar being imported. */
  for (let turn = 0; turn < 100 && !view.container.querySelector(".diff-file-row"); turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A review opens side by side, so the one-column view is what a test has to ask for. */
async function showOneColumn(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show one column"]').click(); });
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
  assert.ok(view.container.querySelector('button[aria-label="Review changes"]'), "the row is back to open it again");
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

test("ticking a file off folds its patch away and empties the tab's count", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  assert.ok(view.container.querySelectorAll(".diff-line").length > 0, "the patch is open");

  await act(async () => { query<HTMLInputElement>(view.container, 'input[aria-label="Mark src/app.ts viewed"]').click(); });

  assert.equal(view.container.querySelectorAll(".diff-line").length, 0);
  assert.match(query(view.container, ".diff-progress").textContent, /1 of 1 viewed/);
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
  assert.deepEqual(sides(), ["main", "HEAD"], "current work appears before the target, even without a remote baseline");

  /** The trigger names the side and what it is set to, so a screen reader hears the comparison. */
  assert.equal(query<HTMLButtonElement>(view.container, '.diff-side button').getAttribute("aria-label"), "Compare: Working tree on main");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Target branch"]').click(); });
  const options = [...document.querySelectorAll('.branch-menu [role="option"]')].map((option) => option.textContent);
  assert.equal(options[0], "HEAD", "the side that is not a branch comes first, inside the list");
  assert.ok(options.includes("origin/main"), "a remote branch can be a base");

  await act(async () => { item([...document.querySelectorAll<HTMLElement>('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main")).click(); });
  assert.deepEqual(sides(), ["main", "origin/main"]);
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
  assert.equal(query(view.container, 'button[aria-label="Show whitespace changes"]').getAttribute("aria-pressed"), "true");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show whitespace changes"]').click(); });
  for (let turn = 0; turn < 100 && names().length < 2; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.deepEqual(asked, [true, false], "the same comparison is read again, counted with whitespace");
  assert.deepEqual(names(), ["src/app.ts", "src/spaced.ts"]);
  assert.ok(view.container.querySelector('button[aria-label="Hide whitespace changes"]'), "the button offers the way back");
  await view.unmount();
});

/** The mode menu is a portal, like the branch picker it replaces. */
async function chooseMode(view: MountView, label: string) {
  await act(async () => { query<HTMLButtonElement>(view.container, '.diff-mode-trigger').click(); });
  const option = item([...document.querySelectorAll<HTMLButtonElement>('.diff-mode-menu button')].find((button) => button.textContent === label));
  await act(async () => { option.click(); });
}

test("the review switches modes, searches commits, and returns to its branch target", async () => {
  seedReviewableProject();
  const latest = { sha: "a".repeat(40), subject: "Finish account migration", author: "Agent", committedAt: "2026-09-10T04:00:00Z" };
  const older = { sha: "b".repeat(40), subject: "Hash reset tokens", author: "Agent", committedAt: "2026-09-09T04:00:00Z" };
  const requested: string[] = [];
  const ranges: unknown[] = [];
  const desktop = reviewableDesktop();
  window.desktop = fakeDesktop({
    diffSummary: async (workspaceId, range, whitespace) => { ranges.push(range); return desktop.diffSummary(workspaceId, range, whitespace); },
    diffPatch: desktop.diffPatch,
    commitHistory: async (_workspaceId, request) => {
      requested.push(request.query);
      return { status: "available", commits: request.query ? [older] : [latest, older], head: latest.sha, offset: 0, hasMore: false };
    },
  });
  const view = await mount(React.createElement(App));
  try {
    await openReview(view);
    await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Target branch"]').click(); });
    await act(async () => { item([...document.querySelectorAll<HTMLElement>('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main")).click(); });
    await chooseMode(view, "Uncommitted");
    assert.deepEqual(ranges.at(-1), { kind: "uncommitted" });
    assert.ok(view.container.querySelector('button[aria-label="Review mode: Uncommitted"]'));
    await chooseMode(view, "Commits");
    assert.deepEqual(ranges.at(-1), { kind: "commit", commit: latest.sha });
    assert.match(query(view.container, '.diff-commit-trigger').textContent, /aaaaaaaFinish account migration/);
    const search = query<HTMLInputElement>(document.body, 'input[aria-label="Search commit messages or SHA"]');
    assert.equal(document.activeElement, search);
    await act(async () => { for (const value of ["r", "re", "reset"]) { search.value = value; search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.deepEqual(requested, ["", "reset"]);
    const matches = [...document.querySelectorAll<HTMLButtonElement>('.commit-menu [role="option"]')];
    assert.equal(matches.length, 1);
    assert.match(item(matches[0]).textContent, /Hash reset tokens/);
    await act(async () => { item(matches[0]).click(); });
    assert.deepEqual(ranges.at(-1), { kind: "commit", commit: older.sha });
    assert.match(query(view.container, '.diff-commit-trigger').textContent, /bbbbbbbHash reset tokens/);
    await chooseMode(view, "Branch");
    assert.deepEqual(ranges.at(-1), { kind: "branches", base: "origin/main", compare: null });
    assert.deepEqual([...view.container.querySelectorAll('.diff-side-trigger > span')].map((span) => span.textContent), ["main", "origin/main"]);
  } finally { await view.unmount(); }
});
