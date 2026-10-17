import assert from "node:assert/strict";
import { test } from "vitest";
import { checksOf, isPullRequestLink, linkOf, linksPullRequest, pullRequestDetails, pullRequestFromCommit, pullRequestFromList, pullRequestQuery, samePullRequest, type PullRequestRef } from "../../src/domain/pull-request.ts";

const listed = (fields: Record<string, unknown> = {}) => [{ number: 12, title: "Name the two families", url: "https://github.com/o/r/pull/12", state: "OPEN", ...fields }];
const fromApi = (fields: Record<string, unknown> = {}) => [{ number: 12, title: "Name the two families", html_url: "https://github.com/o/r/pull/12", state: "open", draft: false, merged_at: null, ...fields }];

test("gh pr list gives the first pull request it found", () => {
  assert.deepEqual(pullRequestFromList(listed()), {
    number: 12,
    title: "Name the two families",
    url: "https://github.com/o/r/pull/12",
    state: "open",
  });
});

test("a draft is only a draft while it is open", () => {
  assert.equal(pullRequestFromList(listed({ isDraft: true }))?.state, "draft");
  assert.equal(pullRequestFromList(listed({ isDraft: true, state: "MERGED" }))?.state, "merged");
});

test("REST reads merged off the date rather than the state", () => {
  assert.equal(pullRequestFromCommit(fromApi({ state: "closed", merged_at: "2026-08-20T00:00:00Z" }))?.state, "merged");
  assert.equal(pullRequestFromCommit(fromApi({ state: "closed" }))?.state, "closed");
  assert.equal(pullRequestFromCommit(fromApi({ draft: true }))?.state, "draft");
});

test("nothing to show is null, however it arrives", () => {
  for (const value of [null, undefined, [], {}, "", [null], [{}]]) {
    assert.equal(pullRequestFromList(value), null);
    assert.equal(pullRequestFromCommit(value), null);
  }
});

test("a record missing a field a row draws is not a pull request", () => {
  assert.equal(pullRequestFromList(listed({ number: 0 })), null);
  assert.equal(pullRequestFromList(listed({ url: "" })), null);
  assert.equal(pullRequestFromList(listed({ state: "QUEUED" })), null);
  assert.equal(pullRequestFromCommit(fromApi({ html_url: undefined })), null);
});

test("a search names a pull request by number or by link", () => {
  assert.deepEqual(pullRequestQuery("12"), { number: 12, repository: null });
  assert.deepEqual(pullRequestQuery(" #12 "), { number: 12, repository: null });
  assert.deepEqual(pullRequestQuery("https://github.com/Acme/App/pull/12#discussion_r1"), { number: 12, repository: "github.com/acme/app" });
  assert.deepEqual(pullRequestQuery("github.com/acme/app/pull/12/files"), { number: 12, repository: "github.com/acme/app" });
  for (const query of ["", "#", "0", "#12a", "panel 12", "https://github.com/acme/app/issues/12"]) assert.equal(pullRequestQuery(query), null, query);
});

test("a link names only the pull request in its own repository", () => {
  const link = { number: 12, url: "https://github.com/acme/app/pull/12" };
  assert.equal(linksPullRequest(link, pullRequestQuery("12")!), true);
  assert.equal(linksPullRequest(link, pullRequestQuery("13")!), false);
  assert.equal(linksPullRequest(link, pullRequestQuery("https://github.com/acme/other/pull/12")!), false);
});

const run = (status: string, conclusion: string | null = null) => ({ __typename: "CheckRun", name: "ci", status, conclusion });
const context = (state: string) => ({ __typename: "StatusContext", context: "deploy", state });

test("gh pr list and gh pr view say what a pull request still needs", () => {
  assert.deepEqual(pullRequestFromList(listed({ mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [run("COMPLETED", "FAILURE")] })), {
    number: 12,
    title: "Name the two families",
    url: "https://github.com/o/r/pull/12",
    state: "open",
    checks: "failing",
    review: "changes-requested",
    conflicts: true,
  });
  assert.deepEqual(pullRequestDetails({ mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: [run("COMPLETED", "SUCCESS")] }), { checks: "passing", review: "approved" });
  assert.deepEqual(pullRequestDetails({ mergeable: "UNKNOWN", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [] }), { review: "required" });
  assert.deepEqual(pullRequestDetails({ reviewDecision: "", statusCheckRollup: null }), {}, "nothing said is nothing needed");
  assert.deepEqual(pullRequestDetails(null), {});
});

test("every check taken together fails on one failure, else waits on one still going", () => {
  assert.equal(checksOf([run("COMPLETED", "SUCCESS"), context("SUCCESS"), run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL")]), "passing");
  assert.equal(checksOf([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS"), context("SUCCESS")]), "pending");
  assert.equal(checksOf([run("QUEUED"), context("PENDING")]), "pending");
  assert.equal(checksOf([context("EXPECTED"), run("COMPLETED", "SUCCESS")]), "pending");
  for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
    assert.equal(checksOf([run("IN_PROGRESS"), run("COMPLETED", conclusion), context("SUCCESS")]), "failing", conclusion);
  }
  assert.equal(checksOf([run("COMPLETED", "SUCCESS"), context("ERROR")]), "failing");
  assert.equal(checksOf([context("FAILURE")]), "failing");
  assert.equal(checksOf([]), undefined);
  assert.equal(checksOf(undefined), undefined);
});

test("a change in what a pull request needs is a change in the answer", () => {
  const ref: PullRequestRef = { number: 12, title: "T", url: "https://github.com/o/r/pull/12", state: "open", checks: "pending" };
  const found = (pullRequest: PullRequestRef) => ({ status: "found" as const, pullRequest });
  assert.equal(samePullRequest(found(ref), found({ ...ref })), true);
  assert.equal(samePullRequest(found(ref), found({ ...ref, checks: "passing" })), false);
  assert.equal(samePullRequest(found(ref), found({ ...ref, review: "approved" })), false);
  assert.equal(samePullRequest(found(ref), found({ ...ref, conflicts: true })), false);
});

test("a thread's link keeps how its pull request stands, and an old one still reads", () => {
  const link = linkOf({ number: 12, title: "T", url: "https://github.com/o/r/pull/12", state: "open", checks: "failing", conflicts: true });
  assert.deepEqual(link, { number: 12, url: "https://github.com/o/r/pull/12", state: "open", title: "T", checks: "failing", conflicts: true });
  assert.equal(isPullRequestLink(link), true);
  assert.equal(isPullRequestLink({ number: 12, url: "https://github.com/o/r/pull/12" }), true);
  assert.equal(isPullRequestLink({ ...link, checks: "flaky" }), false);
  assert.equal(isPullRequestLink({ ...link, state: "queued" }), false);
  assert.equal(isPullRequestLink({ ...link, conflicts: false }), false);
});
