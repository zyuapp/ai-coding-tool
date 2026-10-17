import assert from "node:assert/strict";
import { test } from "vitest";
import { codexPolicy } from "../../../src/main/codex/codex-policy.mts";

test("every execution policy maps onto Codex approvals, sandbox, and reviewer", () => {
  assert.deepEqual(codexPolicy("confirm"), { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("plan"), codexPolicy("confirm"));
  assert.deepEqual(codexPolicy("allow-edits"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("autonomous"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
  assert.deepEqual(codexPolicy("bypass"), { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
});
