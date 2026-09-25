import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { PullRequestAnswer } from "../../src/domain/pull-request.ts";
import { effectOf, projected, task } from "./workspace-reducer-fixtures.mts";

const PULL_REQUEST = { number: 7, title: "Poll me", url: "https://github.com/o/r/pull/7", state: "open" } as const;
const OPEN: PullRequestAnswer = { status: "found", pullRequest: PULL_REQUEST };
const MERGED: PullRequestAnswer = { status: "found", pullRequest: { ...PULL_REQUEST, state: "merged" } };

/** A project whose checkout Git has already answered for, which is what names the branch. */
function checkedOut(branch: string | null = "pr-poll") {
  return projected({
    threads: [task("task-a", { projectId: "project-a" })],
    currentId: "task-a",
    environments: { "workspace-a": { status: "available", files: [], branch, baseline: null, additions: 0, deletions: 0 } },
  });
}

test("a read asks about the checkout in front, on the branch it is on", () => {
  const reading = reduce(checkedOut(), { type: "pull-request.read" });

  assert.deepEqual(effectOf(reading, "read-pull-request"), { type: "read-pull-request", workspaceId: "workspace-a", branch: "pr-poll", read: 1 });
  assert.equal(deriveView(reading.state).pullRequest.status, "none", "nothing is drawn until an answer lands");
});

test("an answer to an overtaken read is dropped, whichever order the two arrive in", () => {
  const first = reduce(checkedOut(), { type: "pull-request.read" });
  const second = reduce(first.state, { type: "pull-request.read" });
  const overtaken = effectOf(first, "read-pull-request");
  const latest = effectOf(second, "read-pull-request");

  const late = reduce(second.state, { type: "pull-request.answered", workspaceId: overtaken.workspaceId, branch: overtaken.branch, read: overtaken.read, answer: OPEN });
  assert.equal(deriveView(late.state).pullRequest.status, "none", "the older ask no longer speaks for the row");

  const answered = reduce(late.state, { type: "pull-request.answered", workspaceId: latest.workspaceId, branch: latest.branch, read: latest.read, answer: OPEN });
  assert.deepEqual(deriveView(answered.state).pullRequest, OPEN);
});

test("only another checkout or another branch blanks the row", () => {
  const asked = reduce(checkedOut(), { type: "pull-request.read" });
  const read = effectOf(asked, "read-pull-request");
  const found = reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: OPEN });

  const again = reduce(found.state, { type: "pull-request.read" });
  assert.deepEqual(deriveView(again.state).pullRequest, OPEN, "asking again about the same checkout leaves the row as it was");

  const moved = reduce({ ...again.state, environments: { "workspace-a": { status: "available", files: [], branch: "other", baseline: null, additions: 0, deletions: 0 } } }, { type: "pull-request.read" });
  assert.equal(deriveView(moved.state).pullRequest.status, "none", "another branch can have another answer, so the row empties first");
});

test("an answer for another branch is not written onto the one on screen", () => {
  const asked = reduce(checkedOut(), { type: "pull-request.read" });
  const read = effectOf(asked, "read-pull-request");

  const elsewhere = reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: "other", read: read.read, answer: OPEN });

  assert.equal(deriveView(elsewhere.state).pullRequest.status, "none");
});

test("a checkout the app no longer has leaves nothing to draw and nothing to ask", () => {
  const asked = reduce(checkedOut(), { type: "pull-request.read" });
  const read = effectOf(asked, "read-pull-request");
  const found = reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: MERGED });

  const closed = reduce({ ...found.state, projects: [], threads: [], currentId: null, draftProjectId: null }, { type: "pull-request.read" });

  assert.equal(closed.effects.length, 0, "with no checkout there is nothing to ask GitHub about");
  assert.equal(closed.state.pullRequest, null);
});

test("an answer that says what the row already says leaves the state alone", () => {
  const asked = reduce(checkedOut(), { type: "pull-request.read" });
  const read = effectOf(asked, "read-pull-request");
  const found = reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: OPEN });

  const polled = reduce(found.state, { type: "pull-request.read" });
  const next = effectOf(polled, "read-pull-request");
  const same = reduce(polled.state, { type: "pull-request.answered", workspaceId: next.workspaceId, branch: next.branch, read: next.read, answer: { ...OPEN } });

  assert.equal(same.state, polled.state, "an unchanged answer never rewrites the row");
});
