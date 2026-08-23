import assert from "node:assert/strict";
import { test } from "vitest";
import { pullRequestFromCommit, pullRequestFromList } from "../src/domain/pull-request.ts";

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
