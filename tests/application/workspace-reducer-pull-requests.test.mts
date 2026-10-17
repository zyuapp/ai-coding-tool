import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { coordinationSections } from "../../src/application/coordination.ts";
import type { PullRequestAnswer } from "../../src/domain/pull-request.ts";
import { activeRun, correlatedRunEvent, effectOf, heldWorktree, projected, required, task } from "./workspace-reducer-fixtures.mts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";

const PULL_REQUEST = { number: 7, title: "Poll me", url: "https://github.com/o/r/pull/7", state: "open" } as const;
const OPEN: PullRequestAnswer = { status: "found", pullRequest: PULL_REQUEST };
const MERGED: PullRequestAnswer = { status: "found", pullRequest: { ...PULL_REQUEST, state: "merged" } };
/** A thread whose work lands as a pull request, which makes the one its checkout is on its own. */
const DELIVERS = { intent: "Ship it", doneWhen: "It merges", delivers: "pull-request" } as const;

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

test("a found pull request is recorded on the thread read, even when the checkout's answer is unchanged", () => {
  const state = projected({
    threads: [task("task-a", { projectId: "project-a" }), task("task-b", { projectId: "project-a" })],
    currentId: "task-a",
    environments: { "workspace-a": { status: "available", files: [], branch: "pr-poll", baseline: null, additions: 0, deletions: 0 } },
  });
  const answer = (from: ReturnType<typeof reduce>) => {
    const read = effectOf(from, "read-pull-request");
    return reduce(from.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: OPEN }).state;
  };

  const first = answer(reduce(state, { type: "pull-request.read" }));
  assert.deepEqual(first.threads.map((thread) => thread.pullRequest), [{ number: 7, url: PULL_REQUEST.url, state: "open", title: "Poll me" }, undefined]);

  const second = answer(reduce(first, { type: "pull-request.read", taskId: "task-b" }));
  assert.deepEqual(second.threads.map((thread) => thread.pullRequest?.number), [7, 7]);
});

test("a coordinator reads the pull request of every checkout its threads work in, once each", () => {
  const projects = [{ id: "a", root: "/a", workspaceId: "workspace-a" }, { id: "b", root: "/b", workspaceId: "workspace-b" }];
  const state = projected({
    projects,
    threads: [
      task("lead", { projectId: "a", role: "coordinator" }),
      task("one", { projectId: "b", parentId: "lead", title: "One", brief: DELIVERS }),
      task("two", { projectId: "b", parentId: "lead", title: "Two", brief: DELIVERS }),
      task("elsewhere", { projectId: "a" }),
    ],
    currentId: "lead",
  });

  const asked = reduce(state, { type: "pull-request.read-members" });
  const reads = asked.effects.filter((effect) => effect.type === "read-pull-request");
  assert.deepEqual(reads.map((effect) => effect.workspaceId), ["workspace-b"], "threads sharing a checkout ask once, and the coordinator's own checkout is not asked");
  const read = effectOf(asked, "read-pull-request");
  assert.deepEqual(deriveView(asked.state).memberPullRequests.found, []);

  const answered = reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, members: true, answer: OPEN });
  const { found, settled } = deriveView(answered.state).memberPullRequests;
  assert.deepEqual(found.map(({ pullRequest, threads }) => [pullRequest.number, threads.map((thread) => thread.id)]), [[7, ["one", "two"]]]);
  assert.equal(settled, false, "an open pull request is still worth asking about");
  assert.equal(answered.state.pullRequest, null, "the checkout in front keeps its own answer");
  assert.deepEqual(answered.state.threads.map((thread) => [thread.id, thread.pullRequest?.number]), [["lead", undefined], ["one", 7], ["two", 7], ["elsewhere", undefined]]);

  const left = reduce(answered.state, { type: "task.set-coordinator", taskId: "one", coordinatorId: null }).state;
  const bothLeft = reduce(left, { type: "task.set-coordinator", taskId: "two", coordinatorId: null }).state;
  const alone = reduce(bothLeft, { type: "pull-request.read-members" });
  assert.equal(alone.effects.length, 0);
  assert.deepEqual(deriveView(alone.state).memberPullRequests.found, [], "a checkout no thread under the coordinator works in stops being drawn");
});

test("a member read takes only answers to member asks on its branch", () => {
  const state = projected({
    projects: [{ id: "a", root: "/a", workspaceId: "workspace-a" }, { id: "b", root: "/b", workspaceId: "workspace-b" }],
    threads: [task("lead", { projectId: "a", role: "coordinator" }), task("one", { projectId: "b", parentId: "lead" })],
    currentId: "lead",
  });
  const asked = reduce(state, { type: "pull-request.read-members" });
  const read = effectOf(asked, "read-pull-request");
  const answer = { type: "pull-request.answered" as const, workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: MERGED };
  assert.equal(reduce(asked.state, { ...answer, members: true, branch: "elsewhere" }).state, asked.state, "another branch");
  assert.equal(reduce(asked.state, answer).state, asked.state, "an ordinary read with the same count");
});

test("a thread that is not a coordinator reads no member pull requests", () => {
  const read = reduce(checkedOut(), { type: "pull-request.read-members" });
  assert.equal(read.effects.length, 0);
  assert.deepEqual(deriveView(read.state).memberPullRequests.found, []);
});

/** A coordinator with one thread in a worktree of its own, whose brief delivers a pull request. */
function delivering(overrides: Partial<ReturnType<typeof task>> = {}) {
  const worktree = heldWorktree();
  return projected({
    worktrees: [worktree],
    threads: [task("lead", { projectId: "project-a", role: "coordinator" }), task("one", { projectId: "project-a", parentId: "lead", worktreeId: worktree.id, brief: DELIVERS, ...overrides })],
    currentId: "lead",
    environments: { [worktree.workspaceId]: { status: "available", files: [], branch: null, baseline: null, additions: 0, deletions: 0 } },
  });
}

/** The coordinator on screen asks after its threads, and GitHub answers with `answer`. */
function memberAnswer(state: WorkspaceState, answer: PullRequestAnswer) {
  const asked = reduce(state, { type: "pull-request.read-members" });
  const read = effectOf(asked, "read-pull-request");
  return reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, members: true, answer }).state;
}

const thread = (state: WorkspaceState, id: string) => required(state.threads.find((item) => item.id === id));

test("a pull request's state and what it still needs are recorded on the thread", () => {
  const failing = memberAnswer(delivering(), { status: "found", pullRequest: { ...PULL_REQUEST, checks: "failing", review: "changes-requested", conflicts: true } });
  assert.deepEqual(thread(failing, "one").pullRequest, { number: 7, url: PULL_REQUEST.url, state: "open", title: "Poll me", checks: "failing", review: "changes-requested", conflicts: true });
  assert.equal(deriveView({ ...failing, currentId: "lead" }).coordination.members[0]?.status, "review");
  assert.equal(deriveView({ ...failing, currentId: "lead" }).coordination.members[0]?.summary, "#7 · Checks failing");

  const passing = memberAnswer(failing, { status: "found", pullRequest: { ...PULL_REQUEST, checks: "passing", review: "changes-requested", conflicts: true } });
  assert.equal(thread(passing, "one").pullRequest?.checks, "passing", "a change in checks alone is written");
  const fixed = memberAnswer(passing, { status: "found", pullRequest: { ...PULL_REQUEST, checks: "passing" } });
  assert.deepEqual(thread(fixed, "one").pullRequest, { number: 7, url: PULL_REQUEST.url, state: "open", title: "Poll me", checks: "passing" }, "what it no longer needs goes");
  const unchanged = reduce(reduce(fixed, { type: "pull-request.read-members" }).state, { type: "pull-request.answered", ...readOf(fixed), members: true, answer: { status: "found", pullRequest: { ...PULL_REQUEST, checks: "passing" } } });
  assert.equal(thread(unchanged.state, "one"), thread(fixed, "one"), "an answer that says the same leaves the thread alone");
});

function readOf(state: WorkspaceState) {
  const read = effectOf(reduce(state, { type: "pull-request.read-members" }), "read-pull-request");
  return { workspaceId: read.workspaceId, branch: read.branch, read: read.read };
}

test("a member resolves itself when its own pull request merges, once", () => {
  const open = memberAnswer(delivering({ outcome: "finished", outcomeUnread: true }), OPEN);
  assert.equal(thread(open, "one").resolvedAt, undefined);

  const merged = memberAnswer(open, MERGED);
  assert.equal(typeof thread(merged, "one").resolvedAt, "number");
  assert.equal(thread(merged, "one").outcome, undefined, "resolving files its last run away, so it no longer holds its coordinator up");
  assert.equal(deriveView(merged).coordination.members[0]?.status, "resolved");

  const reopened = reduce(merged, { type: "task.reopen", taskId: "one" }).state;
  const again = memberAnswer(reopened, MERGED);
  assert.equal(thread(again, "one").resolvedAt, undefined, "a member the user reopened after its merge stays open");

  const legacy = memberAnswer(delivering({ pullRequest: { number: 7, url: PULL_REQUEST.url } }), MERGED);
  assert.equal(typeof thread(legacy, "one").resolvedAt, "number", "a link kept before its state was counts its first merged answer as the merge");

  const sharing = projected({
    threads: [task("lead", { projectId: "project-a", role: "coordinator" }), task("one", { projectId: "project-a", parentId: "lead" })],
    currentId: "lead",
  });
  const users = memberAnswer(memberAnswer(sharing, OPEN), MERGED);
  assert.equal(thread(users, "one").pullRequest?.state, "merged", "the link is still kept for search");
  assert.equal(thread(users, "one").resolvedAt, undefined, "a member in the project's checkout does not resolve with the user's branch");
  assert.notEqual(deriveView(users).coordination.members[0]?.status, "review");
});

test("a member that merges while it works stays filed away when its turn ends", () => {
  const running = { ...delivering({ pullRequest: { number: 7, url: PULL_REQUEST.url, state: "open", title: "Poll me" } }), activeRuns: { one: activeRun("one", "run-one") } };
  const merged = memberAnswer(running, MERGED);
  assert.equal(typeof thread(merged, "one").resolvedAt, "number");
  const ended = reduce(merged, correlatedRunEvent("one", "run-one", 1, { type: "run.status", status: "succeeded" })).state;
  assert.equal(thread(ended, "one").outcome, "finished", "the turn still says how it ended");
  assert.equal(deriveView(ended).coordination.members[0]?.status, "resolved");
  assert.deepEqual(coordinationSections(ended.threads, new Set(), new Set()).priority.map((item) => item.id), [], "a resolved thread does not hold its coordinator up");
});

test("an archived member neither counts toward its checkout's read nor resolves", () => {
  const state = delivering({ archivedAt: 1, pullRequest: { number: 7, url: PULL_REQUEST.url, state: "open" } });
  const asked = reduce(state, { type: "pull-request.read-members" });
  assert.equal(asked.effects.some((effect) => effect.type === "read-pull-request"), false, "a coordinator whose only thread is archived asks nothing");
  const answered = reduce(state, { type: "pull-request.read", taskId: "one" });
  const read = effectOf(answered, "read-pull-request");
  const merged = reduce(answered.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: MERGED }).state;
  assert.equal(thread(merged, "one").pullRequest?.state, "merged", "its own tab still records what it shows");
  assert.equal(thread(merged, "one").resolvedAt, undefined);
});

test("a member's turn ending reads its pull request again on the computer that holds it", () => {
  const state = { ...delivering(), activeRuns: { one: activeRun("one", "run-one") } };
  const ended = reduce(state, correlatedRunEvent("one", "run-one", 1, { type: "run.status", status: "succeeded" }));
  const read = ended.effects.find((effect) => effect.type === "read-pull-request");
  assert.deepEqual(read, { type: "read-pull-request", workspaceId: "worktree-wt1", branch: null, read: 1, members: true, followUp: true });
  assert.deepEqual(ended.state.memberPullRequests["worktree-wt1"]?.threadIds, ["one"]);

  const merged = reduce(ended.state, { type: "pull-request.answered", workspaceId: "worktree-wt1", branch: null, read: 1, members: true, answer: MERGED }).state;
  assert.equal(typeof thread(merged, "one").resolvedAt, "number", "a merge the thread made itself resolves it at once");

  const reporting = { ...delivering({ brief: { ...DELIVERS, delivers: "report" } }), activeRuns: { one: activeRun("one", "run-one") } };
  const told = reduce(reporting, correlatedRunEvent("one", "run-one", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(told.effects.some((effect) => effect.type === "read-pull-request"), false, "a thread with no pull request to deliver or show asks nothing");
});

test("reading one coordinator's pull requests keeps another's read in flight", () => {
  const projects = [{ id: "a", root: "/a", workspaceId: "workspace-a" }, { id: "b", root: "/b", workspaceId: "workspace-b" }];
  const state = projected({
    projects,
    threads: [
      task("lead", { projectId: "a", role: "coordinator" }),
      task("other", { projectId: "a", role: "coordinator" }),
      task("one", { projectId: "a", parentId: "lead", brief: DELIVERS }),
      task("two", { projectId: "b", parentId: "other", brief: DELIVERS }),
    ],
    currentId: "lead",
  });
  const first = reduce(state, { type: "pull-request.read-members" });
  const inFlight = effectOf(first, "read-pull-request");
  const second = reduce(first.state, { type: "pull-request.read-members", taskId: "other" });
  assert.deepEqual(Object.keys(second.state.memberPullRequests).sort(), ["workspace-a", "workspace-b"]);
  const landed = reduce(second.state, { type: "pull-request.answered", workspaceId: inFlight.workspaceId, branch: inFlight.branch, read: inFlight.read, members: true, answer: OPEN }).state;
  assert.equal(thread(landed, "one").pullRequest?.state, "open", "the first coordinator's answer still lands");
});
