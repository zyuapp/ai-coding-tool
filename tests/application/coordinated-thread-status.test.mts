import assert from "node:assert/strict";
import { test } from "vitest";
import { nextSteps, type CoordinatedThreadStatus } from "../../src/application/coordinated-thread-status.ts";
import { NEXT_STEPS, type ThreadBrief } from "../../src/domain/coordination.ts";
import type { PullRequestAnswer, PullRequestLink } from "../../src/domain/pull-request.ts";
import { task } from "./workspace-reducer-fixtures.mts";

const BRIEF: ThreadBrief = { intent: "fix the flaky login test", doneWhen: "the suite passes 50 runs", delivers: "pull-request" };

const OWN_PULL_REQUEST: PullRequestLink = { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix it", state: "open" };

/** What a thread delivering a pull request is offered next, with its pull request standing as `link` says. */
function offered(link: Partial<PullRequestLink> | null, status: CoordinatedThreadStatus = "review", checkout: PullRequestAnswer | null = null) {
  const member = task("worker", { parentId: "lead", brief: BRIEF, ...(link ? { pullRequest: { ...OWN_PULL_REQUEST, ...link } } : {}) });
  return nextSteps(member, status, checkout);
}

test("a thread is offered the next steps its own pull request needs, most pressing first", () => {
  assert.deepEqual(offered({ conflicts: true, checks: "failing", review: "changes-requested" }), ["resolve-conflicts", "fix-ci", "address-comments"]);
  assert.deepEqual(offered({ checks: "failing" }), ["fix-ci"]);
  assert.deepEqual(offered({ review: "changes-requested", checks: "passing" }), ["address-comments"]);
  assert.deepEqual(offered({ review: "approved", checks: "passing" }), ["merge"], "approved and passing can merge");
  assert.deepEqual(offered({}), ["merge"], "a pull request no review is asked of can merge");
  assert.deepEqual(offered({ review: "required", checks: "passing" }), [], "one still waiting on a review cannot");
  assert.deepEqual(offered({ checks: "pending" }), [], "nor one whose checks are still going");
  assert.deepEqual(offered({ conflicts: true }), ["resolve-conflicts"]);
  assert.deepEqual(offered({ state: "draft", checks: "failing" }, "done"), ["fix-ci"], "a draft is fixed but never merged");
  assert.deepEqual(offered({ state: "draft" }, "done"), []);
  assert.deepEqual(offered({ state: "merged" }, "done"), [], "a merged pull request needs nothing more");
  for (const status of ["working", "approval", "asking", "resolved"] as const) {
    assert.deepEqual(offered({ checks: "failing" }, status), [], `nothing while it is ${status}`);
  }
  assert.deepEqual(offered({ checks: "failing" }, "blocked"), ["fix-ci"], "a thread that stopped on something can still be told what to do");

  assert.deepEqual(offered(null, "done"), [], "no pull request yet, and GitHub has not been asked");
  assert.deepEqual(offered(null, "done", { status: "none" }), ["create-pull-request"], "GitHub said it has none");
  assert.deepEqual(offered(null, "done", { status: "gh-missing" }), [], "nothing can be asked without gh");
  assert.deepEqual(offered(null, "working", { status: "none" }), []);
  const reporting = task("worker", { parentId: "lead", brief: { ...BRIEF, delivers: "report" } });
  assert.deepEqual(nextSteps(reporting, "done", { status: "none" }), [], "a thread that delivers a report is never asked for a pull request");
  assert.deepEqual(NEXT_STEPS.map(({ label }) => label), ["Resolve conflicts", "Fix CI", "Address comments", "Merge it", "Create PR"]);
});
